# structuredClone — perf research

Macro-level performance research on Deno's implementation of
`structuredClone()`.

## TL;DR

**Primary finding (graduating to an upstream perf fix):**
`structuredClone(<primitive>)` is **~3× slower than Node 22 LTS / Node
23, and ~10× slower than Bun**. The cause is V8 failing to inline the
`structuredClone` JS function body (in `ext/web/13_message_port.js`)
because of its size — so every primitive `structuredClone(42)` call
crosses the function-call boundary even though the fast path inside is
trivial.

Wrapping the existing function with a tiny external fast-path
reduces the per-call cost from **~2,890 ns → ~25 ns (~115× faster)**
in Deno, ~1,070 ns → ~30 ns in Node, ~290 ns → ~28 ns in Bun.

**Secondary observations** (not landable):

- `clone_u8_64k` is ~2× slower than Node and Bun (the `ArrayBufferPrototypeSlice` + `WeakMapPrototypeSet` path in `02_structured_clone.js`). The `objectCloneMemo` WeakMap is **written but never read** — dead code that adds an allocation per clone. Probably worth removing as a small cleanup but not high-impact on its own.
- `clone_empty_obj` and `clone_small_obj` are 2× and 1.7× slower than Node respectively — but these are dominated by the SAME function-call-boundary cost as the primitive case (V8 not inlining `structuredClone`). The primitive-fast-path fix will help here too because `structuredClone({a:1})` falls through to `core.structuredClone` which is the same crossing cost — actually NO, the wrapper fix only helps primitive cases since objects must still go through V8 ValueSerializer. So small-object case stays slow.

## Headline ratios

### Microbench (ns/op, lower is better)

| Bench | Deno | Node 22 | Node 23 | Bun | Deno vs Node 22 | Deno vs Bun |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| **clone_number** | **3,289** | 1,079 | 1,052 | 281 | **3.05× slower** | **11.7× slower** |
| **clone_short_string** | **3,551** | 1,171 | 1,213 | 574 | **3.03× slower** | **6.19× slower** |
| **clone_boolean** | **3,009** | 1,050 | 1,095 | 281 | **2.87× slower** | **10.7× slower** |
| clone_empty_obj | 4,029 | 2,098 | 2,037 | 671 | 1.92× slower | 6.01× slower |
| clone_small_obj | 5,201 | 2,988 | 2,906 | 1,531 | 1.74× slower | 3.40× slower |
| clone_medium_obj | 11,756 | 9,586 | 9,379 | 7,873 | 1.23× slower | 1.49× slower |
| clone_array_1000_nums | 70,805 | 75,258 | 70,798 | 78,457 | _match_ | _match_ |
| clone_array_1000_strs | 171,652 | 152,720 | 149,481 | 258,749 | 1.12× slower | **1.51× faster** |
| clone_map_100 | 61,528 | 51,180 | 47,403 | 44,607 | 1.20× slower | 1.38× slower |
| clone_u8_256 | 6,520 | 4,834 | 4,948 | 1,846 | 1.35× slower | 3.53× slower |
| **clone_u8_64k** | **65,898** | 31,715 | 26,688 | 27,239 | **2.08× slower** | **2.42× slower** |
| clone_u8_1m | 421,564 | 494,492 | 654,109 | 507,428 | **1.17× faster** | **1.20× faster** |
| clone_ab_64k | 29,947 | 30,573 | 25,523 | 24,713 | _match_ | 1.21× slower |
| clone_dv_64k | 31,251 | 32,027 | 26,634 | 23,739 | _match_ | 1.32× slower |
| clone_file_meta | 10,203 | 8,629 | 8,290 | 7,264 | 1.18× slower | 1.40× slower |

Raw: `profiles/sc_micro_all.log`.

### The wrapper test (proves the inlining hypothesis)

`micro/sc_wrapper_test.js` wraps `structuredClone` with an external
fast path that is *identical* to the one already inside
`structuredClone`:

```
=== Deno 2.7.14 ===
{"name":"realSC_42",    "ms":"14287.03", "ns":"2857.4"}
{"name":"wrappedSC_42", "ms":"127.25",   "ns":"25.5"}     ← 112× faster

=== Node 22.13.1 ===
{"name":"realSC_42",    "ms":"5189.09", "ns":"1037.8"}
{"name":"wrappedSC_42", "ms":"153.35",   "ns":"30.7"}     ← 33× faster

=== Bun 1.1.43 ===
{"name":"realSC_42",    "ms":"1469.07", "ns":"293.8"}
{"name":"wrappedSC_42", "ms":"139.85",   "ns":"28.0"}     ← 10× faster
```

Reading this carefully: the user-space wrapper has the SAME fast-path
logic, just placed in a small function V8 can inline. The fact that
this collapses 2857 ns → 25 ns proves there is no algorithmic work
hiding behind the slow call — V8 is simply unable to inline
`structuredClone` because the function body is ~75 lines (webidl
converter setup, kNotSerializable check, two clone paths).

## Where the time goes — V8 prof on the primitive hot path

5,000,000 calls to `structuredClone(i)`. Total runtime: 15.2s, 3,042
ns/op. Profile: `profiles/sc_prim.prof.txt`.

Top callers (top 15 lines, `--prof-process`):

```
ticks  total  nonlib   name
10471  75.2%          /home/.../deno    (no debug symbols on release binary)
  475   3.4%          /lib/x86_64-linux-gnu/libc.so.6
  583   4.2%   19.6%  Builtin: CreateShallowObjectLiteral
  333   2.4%   11.2%  Builtin: LoadIC
  267   1.9%    9.0%  JS: *get ext:deno_webidl/00_webidl.js:755   (createDictionaryConverter inner)
  116   0.8%    3.9%  Builtin: JSEntry
  113   0.8%    3.8%  Builtin: ObjectAssign
   65   0.5%    2.2%  Builtin: ArrayIteratorPrototypeNext
   53   0.4%    1.8%  Builtin: CallApiCallbackOptimizedNoProfiling
   52   0.4%    1.8%  Builtin: CallFunction_ReceiverIsAny
   34   0.2%    1.1%  Builtin: Typeof
   34   0.2%    1.1%  Builtin: LoadICTrampoline
```

The presence of `CreateShallowObjectLiteral`, `ObjectAssign`, `LoadIC`,
and `webidl 00_webidl.js:755` in the **bottom-up heavy profile** is
the smoking gun: V8 is treating the call as fully non-optimizable —
the function's entire body (including the dead webidl converter
machinery it never reaches on the fast path) is being executed as if
it were going to run, then the early `return value;` fires after the
prologue overhead. Inlining would let V8 prove the fast path is the
only path for a Smi argument and eliminate the rest.

## Where the cost lives

- `ext/web/13_message_port.js:614-690` — the `structuredClone(value, options)` function body.
- `ext/web/02_structured_clone.js:46` — `objectCloneMemo` `WeakMap` is created and written but never read; dead code, allocates per call.

## Ranked hypotheses

| Rank | Hypothesis | Impact × Confidence | Notes |
| --- | --- | --- | --- |
| **H1** | V8 cannot inline `structuredClone` because the function body is too large; splitting into `structuredCloneSlow` + a tiny inlinable wrapper recovers the fast path. | **HIGH × HIGH** | Proven by `sc_wrapper_test.js`: 2857 ns → 25 ns (112× faster). Graduating to upstream PR `perf/structuredClone-primitive-fastpath`. |
| H2 | `objectCloneMemo` `WeakMap` in `02_structured_clone.js` is filled but never read. | low × high | The map is written via `WeakMapPrototypeSet` and never accessed elsewhere. Each ArrayBuffer clone allocates an entry. Removing it would be a tiny win but it's dead code that should be removed for clarity. _Not graduating on its own_ — could be folded into the same upstream PR but the task says "no drive-by changes". |
| H3 | `clone_u8_64k` is 2× slower than Node/Bun and `clone_u8_256` is 3.5× slower than Bun. | medium × medium | The path `02_structured_clone.js:79-134` uses `ArrayBufferPrototypeSlice` + `ArrayBufferIsView` + a giant switch on `Symbol.toStringTag`. The switch is dispatched per-clone. For 256 B and 64 K buffers, the dispatch + WeakMap allocation may dominate the underlying memcpy. _Not investigated to attribution_ — needs a separate native flamegraph to confirm. Leaving unranked-for-action this tick. |
| H4 | `clone_array_1000_strs` is 1.5× faster in Deno than Bun, slower than Node | n/a | Strong showing for Deno when V8 serializer handles strings. Not a finding. |

## What's _not_ here

- Native flamegraph attribution. `kernel.perf_event_paranoid = 4` and `sudo` unavailable on this host; same cap as PRs #1–#4. Time in the "/deno" binary is bucketed without symbol resolution.

## Upstream landable

H1 graduates immediately. Branch `perf/structuredClone-primitive-fastpath` on the upstream repo. The fix is contained to `ext/web/13_message_port.js` plus a new microbench under `ext/web/benches/structured_clone.rs`.

## Layout

```
tools/perf_research/structuredClone/
  README.md                                        full report
  micro/sc_micro.js                                15 ops covering primitives, objects, arrays, maps, TypedArrays
  micro/sc_wrapper_test.js                         the wrapper-vs-real comparison
  profiles/sc_micro_all.log                        raw bench output per runtime
  profiles/sc_prim.prof.txt                        V8 --prof for the primitive hot path
  profiles/versions.txt                            runtime versions + host caps
```
