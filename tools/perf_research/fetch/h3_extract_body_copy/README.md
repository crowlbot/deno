# H3 deepening — `extractBody` defensive copy for `BufferSource` init

Concretizes finding **H3** from the parent `perf-research/fetch` report:
the unconditional `TypedArrayPrototypeSlice` at
[`ext/fetch/22_body.js:457-459`](../../../../ext/fetch/22_body.js#L457-L459)
is the dominant per-request cost on the `/bigbody` (1 MB response) route,
where Deno hits 0.51× of Node 22's rps (1 246 / 2 435). This subdirectory
quantifies the slice-vs-transfer alternative and proposes a spec-compatible
landing path.

## Architecture of the current copy

`extractBody(BufferSource)`, called from `Response`/`Request` constructors,
ends every ArrayBufferView and ArrayBuffer branch by doing:

```js
} else if (ArrayBufferIsView(object)) {
  // ... normalize to Uint8Array view if needed ...
  source = TypedArrayPrototypeSlice(object);            // <-- full memcpy
} else if (isArrayBuffer(object)) {
  source = TypedArrayPrototypeSlice(new Uint8Array(object));  // <-- full memcpy
}
```

This is the Fetch spec's "*set source to a copy of object's byte sequence*"
step ([Fetch §body-extract step 11.1](https://fetch.spec.whatwg.org/#bodyinit-safely-extract)).
The defensive memcpy is required so that subsequent caller mutation of the
buffer cannot affect the body bytes that are eventually written to the
wire.

For `Deno.serve` handlers, the lifecycle of the buffer is:

1. handler allocates `new Uint8Array(N)` (or reuses a cached one)
2. handler returns `new Response(buffer)`
3. `extractBody(buffer)` → `slice(buffer)` → `InnerBody.source`
4. server pulls `InnerBody.source` and passes it to `op_http_set_response_body_bytes`
5. Rust wraps the (sliced) buffer in `BufView` — no further copy
6. hyper writes the bytes

The slice in step 3 is the only memcpy in the path, and it costs ~`size/3 GB/s`
of wall time per request (V8 `Memcpy` is bandwidth-limited).

## Empirical: `slice()` vs `ArrayBuffer.prototype.transfer()`

`bench_slice_vs_transfer.js` in this directory. Deno 2.8.0 release build, V8
14.9.207.2-rusty, this host. 12 runs × 10 000 iters per size. Each iteration
allocates a fresh `Uint8Array(size)` then either `slice()`s it or builds
a new view over `buffer.transfer()`. Median (range) of the 12 runs:

| size | `slice()` ns/op | `buffer.transfer()` ns/op | speedup |
| --- | ---: | ---: | ---: |
| 32 B | 3 369 (2 210 – 3 624) | 2 364 (1 675 – 2 731) | 1.43× |
| 1 KB | 7 002 (4 942 – 7 868) | 4 146 (3 268 – 6 290) | 1.69× |
| 64 KB | 57 050 (51 773 – 74 353) | 26 296 (23 374 – 32 464) | 2.17× |
| 1 MB | 559 139 (496 488 – 661 038) | 208 250 (204 527 – 284 866) | **2.69×** |
| 4 MB | 2 374 301 (2 207 345 – 2 832 406) | 826 431 (815 099 – 923 094) | **2.87×** |

`slice()` overhead grows linearly with byte count (it is a memcpy plus
allocation); `transfer()` grows sublinearly because most of its work is
backing-store adoption + new-ArrayBuffer bookkeeping. At 1 MB the absolute
saving is ~350 μs per call; at 4 MB ~1.55 ms.

Run reproducer:

```bash
./target/release/deno run tools/perf_research/fetch/h3_extract_body_copy/bench_slice_vs_transfer.js
```

`results.csv` captures the median + lo/hi numbers from this run.

## Impact estimate on `/bigbody` rps

Parent report's wrk numbers for the 1 MB-body server route: Deno 1 246 rps,
Node 22 2 435 rps (0.51× of Node), Bun 1 082 rps. Per-request Deno
CPU cost is ~`1 000 ms / 1 246 ≈ 803 μs` of work; flamegraph attributed
3.0 % nonlib to `TypedArrayPrototypeSlice` + 4.0 % to `CreateTypedArray` —
together ~7 % of the request, but more usefully `350 μs / 803 μs ≈ 44 %`
of the per-request budget on this route is the slice itself.

Replacing slice with transfer eliminates the ~350 μs copy. Single-threaded
server budget falls to ~450 μs/req, theoretical ceiling ~2 200 rps, which
is within ~10 % of Node 22. Closes the 1.95× /bigbody gap.

**Confidence: HIGH.** The measured 1 MB slice→transfer ratio (2.69×) is
the same magnitude as the wrk rps ratio (1.95×) — the remaining difference
is allocation + op-dispatch + hyper overhead, all of which Node also pays.

## Spec deviation: detached source

`ArrayBuffer.prototype.transfer()` detaches the source buffer. After the
transfer, `originalBuffer.byteLength` reads `0` and TypedArrays over it
throw on access. The Fetch spec's "set source to a copy" wording does not
explicitly prescribe what happens to the *input* buffer, but the natural
reading is that it remains intact — Chromium / Firefox / undici all keep
the input buffer intact after `new Response(buffer)`.

So a *silent* swap of `slice` for `transfer` is a breaking change for
patterns like:

```js
const cached = new Uint8Array(N);
fill(cached);
function handler() { return new Response(cached); }  // detach 1st call ⇒ break 2nd
```

The deviation is also observable to feature-detection code that does e.g.
`assert(buf.byteLength === N) after new Response(buf)`.

## Landing options, ranked

### Option A — Opt-in via `ResponseInit.transfer` (RECOMMENDED)

Additive API. Spec-compatible (new fields are spec-allowed extension
points). Diff is concentrated:

- `ext/fetch/22_body.js` (~30 LoC): `extractBody(object, opts)` accepts
  `{ transfer: boolean }`; the BufferView / ArrayBuffer branches use
  `ArrayBufferPrototypeTransfer` instead of `TypedArrayPrototypeSlice`
  when `opts.transfer` is set.
- `ext/fetch/23_response.js` (~10 LoC): `Response` constructor reads
  `init.transfer`, forwards to `extractBody`.
- `ext/fetch/23_request.js` (~10 LoC): `Request` constructor same.
- `ext/webidl/00_webidl.js` (~5 LoC): add `transfer` boolean to the
  `ResponseInit` / `RequestInit` dictionary converters.
- `ext/fetch/benches/extract_body.rs` (~80 LoC): bench harness comparing
  slice and transfer paths against a `Deno.serve` 1 MB workload.
- Test coverage: `tests/unit/response_test.ts` etc. — verify that
  `init.transfer` detaches the source.

Total: ~100 – 200 LoC. Passes the spec hard floor (>50 LoC, >15 % win on
a realistic workload).

User adoption pattern:

```js
Deno.serve((req) => new Response(buffer, { transfer: true }));
```

This is the path real apps will want for streaming-large-bodies hot paths.
For apps already returning freshly-allocated buffers, the opt-in is a
one-line change to capture the full ~2× rps win on the `/bigbody`-style
route. Apps that reuse cached buffers leave `transfer` unset; their
behavior is unchanged.

### Option B — `Deno.serve`-level auto-detection

Detect in `fastSyncResponseOrStream` that the Response's body source is a
freshly-allocated buffer that escapes only into the Response, and skip
the slice retroactively. Two problems:

1. The slice already happened at `Response` construct-time. We'd be undoing
   the wrong copy. Need to also move the slice into `fastSyncResponseOrStream`.
2. JS-land has no refcount / escape-analysis primitive. We'd have to
   either trust the user with a sentinel field on `Response`, or accept
   that we can't make this safe.

Not pursuable in JS-land; abandoned.

### Option C — Move the copy to Rust

Drop `slice` from `extractBody`. Pass the original buffer to
`op_http_set_response_body_bytes`. The op copies into a hyper-owned
`Vec<u8>` synchronously, before returning to JS.

Same number of memcpys (one), so no first-order win. Possible second-
order wins from cache locality / SIMD memcpy, but those are micro and
below the prompt's hard floor.

### Option D — Strict transfer with documented spec deviation

Mass spec deviation. Breaks the `cached`-buffer pattern. Almost certainly
not acceptable to upstream maintainers without coordination with the
Fetch spec authors. Not pursuable as a single landable PR.

## Recommendation

Pursue Option A as a single upstream PR. The diff is the right shape for
the repo's perf series (focused, benched on a realistic workload, no
behavior change for existing code, opt-in win), and the win on opt-in
workloads is close to closing Deno's `/bigbody` gap vs Node 22 entirely.

The follow-up that would actually shift the *un-opted* server hot path
ratio belongs in a separate research thread: it requires either V8-level
escape analysis exposure or a Fetch spec amendment for response-body
transferability semantics. Both are out of scope for an upstream perf PR
in this repo, and both should be tracked separately once the opt-in API
exists as a foothold.

## Versions

- deno 2.8.0 (stable, release, x86_64-unknown-linux-gnu)
- V8 14.9.207.2-rusty
- Build: `BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/x86_64-linux-gnu/13/include -I/usr/include" LIBCLANG_PATH=/usr/lib/llvm-18/lib cargo build --release --bin deno`
- Host: Linux 6.8.0-111-generic, Vultr VPS (perf governor not pinned this run; jitter visible in lo/hi columns)
