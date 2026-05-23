# perf research: ext/http (Deno.serve)

Macro performance research on Deno's HTTP server stack — the JS-side glue
between `hyper` and the `Deno.serve` user callback. Profile attribution is
JS-side only (V8 `--prof`); native attribution is left unranked on this
host because `kernel.perf_event_paranoid` cannot be lowered without privilege
that isn't available here (`sudo` requires a password despite the prompt's
claim, same constraint hit by `perf-research/fetch`).

## Headline

**No new architectural finding.** Every JS-side cost on the Deno.serve hot
path that crosses the prompt's "architectural" bar is already a finding in
`perf-research/fetch` (PR #1) and either has an open upstream PR or is
explicitly dropped as below-floor:

| ext/http hot spot | covered by | upstream PR |
| --- | --- | --- |
| Header `byteLowerCase` scan (`StringToLowerCaseIntl`, 4.2 % on `headers_read`) | fetch report **H1** | denoland/deno#33683 (open) |
| `_iterableHeaders` rebuild + sort (`ArrayPowerSort` + sort callback, 5.7 % on `headers_read`) | fetch report **H2** | denoland/deno#34284 (open) |
| `extractBody` defensive copy for BufferSource | fetch report **H3** | denoland/deno#34321 (open) |
| `Response` init record converter (`initializeAResponse`, ~6 – 10 %) | fetch report **H4** | below the 15 % floor — not pursued |

The `mapped` wrapper in `ext/http/00_serve.ts:553-680` shows ~4 – 8 % of JS
time across both workloads, but this is per-request orchestration that the
public `Deno.serve` contract requires (build `InnerRequest`, brand-check
the user's `Response`, dispatch to `op_http_set_response_*`). There is no
subsystem-redesign that preserves the contract; cutting individual costs
(one fewer allocation here, one fewer brand-check there) is the kind of
single-call-site work the prompt explicitly excludes.

## Methodology

- Workloads under `servers/`. Each is a `Deno.serve` handler representative
  of a real shape: `json_tiny` (small JSON response with one header set),
  `headers_read` (iterate every request header + read one by name, return
  a small JSON ack).
- Driver: `autocannon -c 32 -d 10` after a 3 s warmup. Same host, no
  governor pinning, single-process server.
- V8 `--prof` in-process; the V8 isolate log is processed with
  `node24 --prof-process` (Node 22's bundled tick processor is too old for
  the V8 14.9 log format produced by Deno 2.8.0).
- Profile artifacts under `profiles/<workload>/`: raw `isolate-*.log`,
  processed `prof.txt`, and `autocannon.json`.

Repro:

```bash
./tools/perf_research/http-serve/run_prof.sh json_tiny     10 32
./tools/perf_research/http-serve/run_prof.sh headers_read  10 32
```

## Top JS-side attribution

### `json_tiny` (27 222 rps)

| share | symbol | location |
| ---: | --- | --- |
| 12.1 % nonlib | `*<anonymous>` | `ext:deno_webidl/00_webidl.js:1096:10` (async-iter `[Symbol.asyncIterator]() { return this; }` — V8 prof attribution artifact; the actual hot caller is somewhere else) |
| 9.9 % | `*initializeAResponse` | `ext:deno_fetch/23_response.js:176:29` (fetch **H4**) |
| 8.2 % | `*mapped` | `ext:deno_http/00_serve.ts:553` (per-request orchestration) |
| 4.1 % | `*Response` | `ext:deno_fetch/23_response.js:314:14` (Response ctor) |
| 3.1 % | `Builtin: CreateShallowObjectLiteral` | (driven by ResponseInit / 23_response.js paths) |
| 2.8 % | `Builtin: LoadIC` | (hidden-class IC misses across the request) |
| 2.6 % | `Builtin: StringToLowerCaseIntl` | (Content-Type case-insensitive check in `initializeAResponse`) |
| 1.7 % | `*extractBody` | `ext:deno_fetch/22_body.js:445:21` (fetch **H3**) |

### `headers_read` (28 604 rps)

| share | symbol | location |
| ---: | --- | --- |
| 7.6 % nonlib | `*<anonymous>` | `ext:deno_webidl/00_webidl.js:1096:10` (same async-iter artifact) |
| 6.1 % | `*initializeAResponse` | `ext:deno_fetch/23_response.js:176:29` (H4) |
| 4.6 % | user handler | `tools/perf_research/http-serve/servers/headers_read.js:7` |
| 4.3 % | `*mapped` | `ext:deno_http/00_serve.ts:553` |
| 4.2 % | `Builtin: StringToLowerCaseIntl` | (fetch **H1** — Headers iteration `byteLowerCase`) |
| 3.3 % | `*<anonymous>` | `ext:deno_fetch/20_headers.js:225:25` (fetch **H2** — `_iterableHeaders` rebuild) |
| 2.9 % | `*get headers` | `ext:deno_fetch/23_request.js:489:14` (lazy headers list materialization) |
| 2.5 % | `Builtin: ArrayPrototypePush` | (driven by `_iterableHeaders` rebuild — **H2**) |
| 2.5 % | `Builtin: ArrayPowerSort` | (Headers iter sort — **H2**) |
| 1.9 % | `Builtin: ArrayPrototypeSort` | (same — **H2**) |

50 – 55 % of `total` ticks land in `/target/release/deno` and are not
attributable from JS-side profiling alone — native costs (hyper, op
dispatch, libc, kernel) need `perf` / `samply` which need
`kernel.perf_event_paranoid <= 1`. That budget is the obvious next research
direction once the host constraint lifts; it is not a JS-side architectural
question.

## Why this investigation is short

The Deno.serve JS surface (`ext/http/00_serve.ts`, `01_http.js`,
`02_websocket.ts`) is a thin orchestration layer over the fetch types
(`Request`, `Response`, `Headers`, `InnerBody`). The hot JS costs of running
a `Deno.serve` handler are dominated by the cost of *constructing and reading
those fetch types*, which is precisely what `perf-research/fetch` (PR #1)
already characterized. Re-profiling at the ext/http layer doesn't surface
new architectural targets; it re-affirms the same H1 – H4 findings under a
different workload shape.

The orchestration cost in `mapped` (4 – 8 %) is real but not architectural in
the sense the prompt requires: there is no subsystem redesign that preserves
the `Deno.serve` contract while eliminating it. Individual call-site tweaks
are below the floor.

## Versions

- deno 2.8.0 (stable, release, x86_64-unknown-linux-gnu)
- V8 14.9.207.2-rusty
- node v22.22.2 (load driver)
- node v24.0.1 (V8 prof log post-processor; v22's is for V8 12.x and
  errors on the v14.9 log format)
- autocannon (npm install autocannon, version per `/tmp/node_modules/autocannon/package.json`)
- Build: `BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/x86_64-linux-gnu/13/include -I/usr/include" LIBCLANG_PATH=/usr/lib/llvm-18/lib cargo build --release --bin deno`
- Host: Linux 6.8.0-111-generic, Vultr VPS, governor not pinned

## Reference

- `perf-research/fetch` (PR #1) — parent investigation; H1 – H6 findings ranked there.
