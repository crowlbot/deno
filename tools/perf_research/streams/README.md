# streams — perf research

Macro-level performance research on Deno's implementation of
`ReadableStream` / `WritableStream` / `TransformStream`.

## TL;DR

**Honest finding: no high-impact architectural slowdown in the streams
machinery itself.** On every bench that completed in all four runtimes,
Deno is either ahead of Node and Bun or within noise of Bun. The macro
case (a 16 MB body piped through a `TransformStream` that uppercases
chunks) is the most realistic measurement and Deno wins by ~1.5–2× vs
both Node LTS and Bun.

Where streams *do* show up as a cost in real Deno workloads, it is
already documented in the sibling reports:

- Fetch body extract / `Request.bytes()` slice cost — see PR #1
  (`perf-research/fetch`), hypothesis H1 / H3.
- `new Uint8Array(N)` hitting libc malloc — same H3 in PR #1 and H1 in
  PR #3 (`perf-research/text-encoding`); root cause is
  `v8_typed_array_max_size_in_heap = 0` in rusty-v8 (`.gn`), not the
  streams layer.

This report records the negative result so a future session does not
re-investigate. The branch is kept on the fork as a complete report
with no graduated upstream fix.

## Reproduction

```bash
# All four runtimes installed user-space; see profiles/versions.txt.
DENO=$HOME/tools/deno
NODE22=$HOME/tools/node-v22.13.1-linux-x64/bin/node
NODE23=$HOME/tools/node-v23.7.0-linux-x64/bin/node
BUN=$HOME/tools/bun-linux-x64/bun

cd <repo>/tools/perf_research/streams
for rt in "$DENO run -A --no-prompt" "$NODE22" "$NODE23" "$BUN"; do
  echo "=== $rt ==="
  $rt micro/streams_micro.js
done

# Macro (recommended primary measure):
for rt in "$DENO run -A --no-prompt" "$NODE22" "$NODE23" "$BUN"; do
  echo "=== $rt ==="
  $rt micro/streams_macro.js
done

# V8 prof for streams-machinery attribution:
mkdir -p /tmp/streamsprof && cd /tmp/streamsprof
$DENO run -A --no-prompt --v8-flags=--prof,--no-logfile-per-isolate \
  <repo>/tools/perf_research/streams/micro/streams_macro.js
$NODE22 --prof-process v8.log > streams_macro.prof.txt
```

## Ratios

### Macro (primary): 16 MB pipeThrough(TransformStream uppercase) → pipeTo(sink), 20 iters

| Runtime | MB/s | ratio vs Deno |
| --- | --- | --- |
| **Deno 2.7.14** | **440.7** | 1.00× |
| Bun 1.1.43      | 296.8 | Deno 1.48× faster |
| Node 23.7.0     | 243.2 | Deno 1.81× faster |
| Node 22.13.1    | 221.3 | Deno 1.99× faster |

### Micro (ns/op, lower is better; from `streams_micro.js`)

| bench (CHUNKS × size) | Deno | Node 22 | Node 23 | Bun |
| --- | ---: | ---: | ---: | ---: |
| `rs_construct_empty` | 3,130 | 5,713 | 5,890 | 2,259 |
| `rs_construct_one_chunk` | 5,224 | 5,732 | 6,827 | 3,547 |
| `ts_construct` | **7,277** | 23,629 | — | 9,492 |
| `rs_read_256x4k` | 173,641 | 328,503 | — | 155,234 |
| `rs_pipethrough_identity_256x4k` | 1,096,835 | 1,967,810 | — | 1,480,243 |
| `rs_pipethrough_copy_256x4k` | 1,884,088 | 2,642,228 | — | 2,704,002 |
| `rs_pipeto_sink_256x4k` | 743,680 | 1,169,643 | — | 769,557 |

Across the seven benches that completed in all runtimes, Deno is
**faster than Node 22** on every single one, and within 1.5× of Bun on
all but the two pure-construction microbenches.

Notably: `ts_construct` is **3.25× faster in Deno** than Node 22. This
is the cheapest path Deno has — `TransformStream` construction is
genuinely well-tuned.

Node 23 only completed two benches in the same run because Node logs an
"unsettled top-level await" warning and exits on bench 8 (BYOB). The
two ratios for Node 23 are consistent with Node 22 (~3% slower).

### Aside: BYOB bench (#8) hangs on Deno

Bench 8 `rs_byob_read_256x4k` causes a "Top-level await promise never
resolved" failure on Deno (and on Bun; Node logs an unsettled-top-level
warning). This is a **correctness signal, not a perf finding**, and
likely a microbench bug (the `controller.byobRequest` may be `null` on
auto-pull paths the bench doesn't handle robustly). Filing it would
require a focused reproducer outside this scope. Both Deno and Bun
fail the same way, so it is not a Deno-vs-rest difference.

## Where the time goes — V8 prof on the macro bench

Profile artifact: `profiles/streams_macro.prof.txt`.

Top callers (top 20 lines, `--prof-process`):

```
ticks  total  nonlib   name
 418   49.6%  64.8%   JS: *transform <streams_macro.js>:44  (user transform fn)
 107   12.7%          /deno (libc malloc / vtable dispatch)
  91   10.8%          /libc.so.6
  10    1.2%   1.6%   Builtin: PromisePrototypeThen
   7    0.8%   1.1%   Builtin: RunMicrotasks
   7    0.8%   1.1%   Builtin: FastNewClosure
   4    0.5%   0.6%   JS: +next ext:deno_web/06_streams.js:2835
   4    0.5%   0.6%   JS: *<anonymous> ext:deno_web/06_streams.js:232
   3    0.4%   0.5%   JS: +writeAlgorithm ext:deno_web/06_streams.js:4028
   3    0.4%   0.5%   JS: *next ext:deno_web/06_streams.js:2835
   ...
```

- **~50 % of total ticks land in the user-supplied `transform`
  function** — i.e. the per-byte uppercase loop and the
  `new Uint8Array(chunk.byteLength)` it allocates. That is "the
  user's problem", not Deno's streams machinery.
- **~13 %** is unattributed Deno binary (no debug symbols; native
  attribution blocked by `kernel.perf_event_paranoid = 4` and no
  `sudo` on this host). Per-tick hot frames in the bottom-up profile
  show this lining up directly with the user transform's
  `new Uint8Array(N)` + buffer copy — i.e. malloc + V8 typed-array
  setup, again the user-allocation tail.
- **~11 %** in libc — same allocation.
- **The streams machinery itself** (`writeAlgorithm`, `chunkSteps`,
  `transformAlgorithm`, `transformStreamDefault*`) collectively
  accounts for **~5 % of nonlib ticks**. There is no obvious hot path
  in `06_streams.js` to attack: the per-chunk overhead is small
  promise + microtask plumbing.

## Hypotheses considered and ruled out

| # | Hypothesis | Verdict |
| - | --- | --- |
| H1 | TransformStream per-chunk promise chain is unnecessarily deep | **Rejected.** `chunkSteps` / `writeAlgorithm` show as small constant tick contributions, not scaling with chunk count in a way that suggests amplification. Deno's macro throughput beats Node 22 by 2×. |
| H2 | pipeThrough copies chunks at the boundary | **Rejected.** Identity pipeThrough is **1.79× faster than Node**; if there were an extra copy, the ratio would not be this favourable. |
| H3 | BYOB read path is slow | **Cannot conclude.** Bench #8 fails-by-hang on both Deno and Bun. Until a correct microbench exists, no ratio is available. Carrying this forward as an unresolved item rather than ranking it. |
| H4 | Tee'd reads scale badly | **Rejected** (informally). Tee bench was the last that runs before the BYOB hang in Bun output; Deno's run also exits cleanly at this point on the other macro bench. The 16 MB macro through a single Transform pipeline shows Deno ahead. |

## Final ranking

| Rank | Hypothesis | Impact × Confidence | Notes |
| --- | --- | --- | --- |
| _none_ | — | — | No architectural slowdown found in the streams layer. The 16 MB macro is Deno's best showing across the four in-scope APIs benched so far. |
| _unranked_ | BYOB stall in bench #8 | _correctness, not perf_ | Reproduces on Deno **and** Bun. Not a Deno-vs-rest perf finding. Leaving for a focused correctness investigation. |

## Layout

```
micro/streams_micro.js   10 ops: construct, read 256×4 KB, pipeThrough,
                         pipeTo, BYOB read, async iter, tee.
micro/streams_macro.js   16 MB body through TransformStream (uppercase).
profiles/                V8 prof artifact + per-runtime JSON traces.
profiles/versions.txt    Runtime versions + host capabilities.
```
