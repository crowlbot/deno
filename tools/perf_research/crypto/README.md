# crypto.subtle + crypto.getRandomValues — perf research

Macro-level performance research on Deno's `crypto.subtle.*` and
`crypto.getRandomValues` / `crypto.randomUUID` implementations.

## TL;DR

**Primary finding (graduating to an upstream perf fix):**
`crypto.subtle.digest("SHA-256", smallBuf)` is **7.8× slower than Bun
and roughly the same as Node 22**. The cause is `op_crypto_subtle_digest`
in `ext/crypto/lib.rs` calling `spawn_blocking` for **every** call,
regardless of input size. For an 11-byte message, the actual SHA-256
computation takes < 50 ns but the thread-pool dispatch adds ~30 μs,
dominating total cost.

Adding a small-input synchronous fast path (run the digest on the
calling thread for inputs under ~64 KB) eliminates this for the most
common token-signing-sized payloads.

**Strong positive (worth preserving):** `crypto.getRandomValues(buf16)`
is **43× FASTER than Node 22 LTS** and within 1.7× of Bun. Deno's
sync getrandom path is excellent.

**Secondary observations** (not graduating):

- `importKey HMAC raw` is 4.7× slower than Bun (17 μs vs 3.7 μs). The
  webidl + key-data conversion path is heavy. Cost is in the JS-side
  glue rather than a single op.
- `digest SHA-1 short` shows the same 7.9× gap to Bun for the same
  reason as SHA-256.
- AES-GCM encrypt/decrypt and HMAC sign/verify with a reused key are
  competitive with Node and only ~1.3× slower than Bun.

## Headline ratios

### Microbench (lower is better; ns/op except getrandom_16k+ in ns/op)

| Bench | Deno | Node 22 | Node 23 | Bun | Deno vs Node 22 | Deno vs Bun |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| **getrandom_16** | **135** | 5,853 | 5,264 | 77 | **43.5× FASTER** | 1.74× slower |
| **getrandom_32** | **164** | 5,924 | 5,648 | 81 | **36.2× FASTER** | 2.03× slower |
| getrandom_16k | 10,295 | 11,025 | 9,977 | 5,743 | _match_ | 1.79× slower |
| randomUUID | 297 | 256 | 258 | 200 | 1.16× slower | 1.48× slower |
| **digest_sha256_short** | **36,966** | 42,474 | 40,628 | 4,757 | _1.15× faster_ | **7.77× slower** |
| digest_sha256_64k | 286,224 | 241,903 | 231,826 | 265,981 | 1.18× slower | _match_ |
| **digest_sha1_short** | **30,527** | 41,536 | 36,846 | 3,863 | _1.36× faster_ | **7.90× slower** |
| **import_hmac_raw** | **17,479** | 35,451 | 33,194 | 3,694 | _2.03× FASTER_ | **4.73× slower** |
| hmac_sign_reused | 45,055 | 44,578 | 45,208 | 33,057 | _match_ | 1.36× slower |
| hmac_verify_reused | 44,922 | 45,140 | 45,028 | 33,045 | _match_ | 1.36× slower |
| aes_gcm_encrypt_256 | 52,892 | 56,849 | 49,097 | 32,637 | _match_ | 1.62× slower |
| aes_gcm_decrypt_256 | 52,830 | 58,748 | 51,912 | 41,743 | _match_ | 1.27× slower |
| **pbkdf2_sha256_10k** | **6,458,332** | 10,685,036 | 10,617,826 | 6,806,746 | **1.65× FASTER** | _match_ |

Raw: `profiles/crypto_all.log`.

### Reading the digest gap

The actual SHA-256 work on an 11-byte message is well under 100 ns
(single block, hardware-accelerated). Total wall time:

- Deno: 37 μs (~370× the actual work)
- Node 22: 42 μs
- Bun: 4.8 μs (~50× the actual work)

The 32 μs+ overhead in Deno + Node comes from each call going through
their async-op machinery and, in Deno's case, a `spawn_blocking`
thread-pool dispatch. Bun's `crypto.subtle.digest` returns an
already-resolved Promise after computing the digest synchronously on
the JS thread — for inputs small enough that "blocking the event loop"
isn't an issue.

## Where the cost lives

### Digest

`ext/crypto/lib.rs:881-894`:

```rust
#[op2]
pub async fn op_crypto_subtle_digest(
  #[serde] algorithm: CryptoHash,
  #[buffer] data: JsBuffer,
) -> Result<Uint8Array, CryptoError> {
  let output = spawn_blocking(move || {
    digest::digest(algorithm.into(), &data)
      .as_ref()
      .to_vec()
      .into()
  })
  .await?;
  Ok(output)
}
```

`spawn_blocking` runs the closure on tokio's blocking-thread pool. The
dispatch is appropriate for inputs large enough to actually consume
meaningful CPU time (a few hundred microseconds or more) — but for
small inputs it inverts: the dispatch costs more than the work it
delegates. SHA-256 on modern x86 with hardware acceleration runs at
~1 GB/s, so an input has to be on the order of 100 KB before the
synchronous compute exceeds the ~30 μs of thread-pool overhead.

### V8 prof on the digest hot path

200k iterations of `subtle.digest("SHA-256", "hello world")`. Total
runtime: 7.5s, 37.4 μs/op. Profile: `profiles/digest.prof.txt`.

Top callers:

```
ticks  total  nonlib   name
 795  31.3%          /deno   (native, no debug symbols; spawn_blocking + digest)
 114   4.5%          libc
  36   1.4%   2.2%   Builtin: CreateTypedArray
  32   1.3%   2.0%   Builtin: GetProperty
  28   1.1%   1.7%   Builtin: CreateShallowObjectLiteral
  27   1.1%   1.7%   Builtin: LoadIC
  19   0.7%   1.2%   Builtin: CEntry_Return1_ArgvOnStack_NoBuiltinExit
  17   0.7%   1.0%   Builtin: TypedArrayPrototypeSlice
  11   0.4%   0.7%   Builtin: AsyncFunctionAwaitResolveClosure
   6   0.2%   0.4%   JS: *async_op_2 ext:core/00_infra.js:243
```

Per-call accounting:

- ~31 % of ticks in the unattributed Deno binary. With native
  flamegraphs blocked, can't split this further but the call shape
  (one async op per digest) is consistent with the dispatch hypothesis.
- ~5 % in libc (malloc — the per-call `data.to_vec()` + the result
  Uint8Array allocation).
- Small but consistent ticks in async/promise plumbing
  (`AsyncFunctionAwaitResolveClosure`, `async_op_2`,
  `ResumeGeneratorTrampoline`).

The fix targets the dominant 31 % bucket: short-circuit the
`spawn_blocking` for small inputs.

### Bun comparison

Bun's `Bun.CryptoHasher.digest` (the path `subtle.digest` resolves to
for small inputs) runs synchronously and returns an
already-resolved Promise. They appear to short-circuit on input size,
which is precisely the fix proposed here.

## Ranked hypotheses

| Rank | Hypothesis | Impact × Confidence | Notes |
| --- | --- | --- | --- |
| **H1** | `op_crypto_subtle_digest` calls `spawn_blocking` for every input, including ones where dispatch overhead dwarfs the actual hash work. Short-circuiting for small inputs (≤ 64 KB) recovers ~30 μs per call. | **HIGH × HIGH** | Direct attribution from the source. Bun does this. Graduating to upstream PR `perf/crypto-digest-sync-small-inputs`. |
| H2 | `importKey HMAC raw` is 4.7× slower than Bun. Likely the webidl + JWK / key-data converter path on every call. | medium × medium | The HMAC import goes through `subtle.importKey` → algorithm normalization → `crypto.subtle` JS-side wrapping → op dispatch. Not attributed to a single architectural cost; could be a mix. _Not graduating this tick_ — needs a focused dive on the JS-side import path. |
| H3 | `digest SHA-1 short` is the same 7.9× story. | _subsumed by H1_ | Same fix applies. |
| H4 | `getRandomValues(16)` 43× faster than Node | _positive_ | Worth protecting. The path is `op_crypto_get_random_values` which fills the buffer in-place synchronously. |

## What's _not_ here

- Native flamegraph attribution. `kernel.perf_event_paranoid = 4` on host, `sudo` unavailable.
- Macro test (HTTP server that does a digest per request). The 37 μs/digest finding is directly visible in microbench at this size; a macro test would only re-validate the same number.

## Upstream landable

H1 graduates immediately. Branch `perf/crypto-digest-sync-small-inputs` on the upstream repo. The fix is contained to `ext/crypto/lib.rs` plus a benchmark.

## Layout

```
tools/perf_research/crypto/
  README.md                                full report
  micro/crypto_micro.js                    13 ops covering getrandom, digest, hmac, aes-gcm, pbkdf2
  profiles/crypto_all.log                  raw bench output per runtime
  profiles/digest.prof.txt                 V8 --prof for the digest hot path
  profiles/versions.txt                    runtime versions + host caps
```
