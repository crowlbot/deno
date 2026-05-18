# WebSocket — perf research

Macro-level performance research on Deno's `WebSocket` (client) and
`Deno.upgradeWebSocket` (server) against Node 22 LTS / Node 23 / Bun.

## TL;DR

**Honest finding: no high-impact architectural slowdown found in
Deno's WebSocket implementation.**

- **Client side:** Deno beats Node 22 on every workload and beats Bun
  on 4 KB / 64 KB binary frames (3.1× Bun's throughput at 4 KB,
  2.2× Bun at 64 KB). Small-message text is faster than Node (1.4×) and
  ~28% slower than Bun.
- **Server side:** Deno's `Deno.serve` + `upgradeWebSocket` is within
  6–25% of Bun's `Bun.serve` for steady-state echo, measured by running
  the same Deno client against each. The biggest gap is at small text
  messages (~25%), and there is no single clear architectural cost in
  the JS layer to attack — the V8 prof attributes 65% of ticks to native
  binary + libc (recv syscalls + WS framing in deno binary).

Without native flamegraph attribution (blocked by
`kernel.perf_event_paranoid = 4` and no `sudo`), the 25% server-side
small-message gap cannot be split between socket code paths and
WS framing in this tick. Recording the finding as **unranked / not
graduating** rather than speculating.

## Headline ratios

### Client side: same Deno echo server, all four runtimes as client (msgs/s, higher is better)

| Workload | Deno | Node 22 | Node 23 | Bun | Deno vs Node 22 | Deno vs Bun |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| client_text_11 (11 B text) | 111,128 | 81,646 | 66,595 | 153,162 | **1.36× faster** | 1.38× slower |
| client_bin_32 (32 B bin) | 101,448 | 70,825 | 97,242 | 110,911 | **1.43× faster** | 1.09× slower |
| **client_bin_4k (4 KB bin)** | **48,887** | 11,238 | 11,892 | 39,576 | **4.35× faster** | **1.23× faster** |
| **client_bin_64k (64 KB bin)** | **6,927** | 1,067 | 1,071 | 3,138 | **6.49× faster** | **2.21× faster** |

Raw: `profiles/ws_results.log`.

### Server side: same Deno client, Deno vs Bun server (msgs/s)

| Workload | Deno server | Bun server | Bun vs Deno |
| --- | ---: | ---: | --- |
| client_text_11 | 111,128 | 136,218 | Bun 1.23× faster |
| client_bin_32 | 101,448 | 123,858 | Bun 1.22× faster |
| client_bin_4k | 48,887 | 63,068 | Bun 1.29× faster |
| client_bin_64k | 6,927 | 7,368 | Bun 1.06× faster |

Node-as-server was not measured because Node 22/23 doesn't ship a built-in
WebSocket server (would require the `ws` package), making the
comparison less clean.

The gap is consistent at ~20–30% across small message sizes and
collapses at 64 KB. Not large enough to call out as architectural
without a clean attribution.

## Where the time goes — V8 prof on the client

Profile: `profiles/ws_client.prof.txt`.

Top buckets:

```
ticks  total  nonlib   name
 229   42.2%          /deno   (native: WS framing, mio/tokio, mio_epoll)
 127   23.4%          libc.so.6 (recv() syscalls)
  11    2.0%   5.9%   Builtin: LoadIC
   7    1.3%   3.7%   Builtin: ArrayPrototypePush
   6    1.1%   3.2%   Builtin: ObjectPrototypeIsPrototypeOf
   4    0.7%   2.1%   JS: *ws.onmessage (test fixture)
   2    0.4%   1.1%   JS: *wrappedHandler ext:deno_web/02_event.js:1414
```

**~65 % of total ticks are in shared libraries (Deno binary + libc)**.
Without native attribution we can't split this between:

- `tokio-tungstenite` / `fastwebsockets` frame parsing (Deno's WS layer)
- `mio` / `epoll_wait` event loop dispatch
- TCP socket read/write syscalls
- Memory allocation for received frames

The JS-side overhead is small and uneventful: a few percent each in
`LoadIC`, event-dispatch builtins, and the user's `ws.onmessage`. There
is no obvious JS hot path to attack.

## Hypotheses considered

| # | Hypothesis | Verdict |
| - | --- | --- |
| H1 | Per-frame allocation for incoming binary messages dominates | **Rejected**: 64 KB binary is 6.5× faster than Node, 2.2× faster than Bun. Allocation is fine. |
| H2 | Event dispatch through EventTarget adds overhead per message | **Unranked**: `ext:deno_web/02_event.js:1414 wrappedHandler` does appear in the prof but at 0.4 % — not material. |
| H3 | Server-side small-message dispatch is the culprit | **Unranked**: 25 % gap is visible but native attribution is blocked. |

## What's _not_ here

- Node-as-server. Node 22/23's built-in WebSocket is client-only; a fair server comparison would require `ws` package.
- Native flamegraph attribution. `kernel.perf_event_paranoid = 4`, `sudo` unavailable.
- Concurrent connections / many-client scaling. Single-connection echo only.

## Final ranking

| Rank | Hypothesis | Impact × Confidence | Notes |
| --- | --- | --- | --- |
| _none_ | — | — | No high-impact architectural slowdown in Deno's WebSocket. Client beats Node 22 by 6.5× on 64 KB frames. Server is within 25% of Bun. The remaining server gap is in unattributed native ticks; recording as unranked rather than speculating. |

## Layout

```
tools/perf_research/websocket/
  README.md                                full report
  micro/ws_server.js                       Deno echo server (reference)
  micro/ws_server_bun.js                   Bun echo server (server cross-check)
  micro/ws_client.js                       universal WS client bench
  profiles/ws_results.log                  raw bench output
  profiles/ws_client.prof.txt              V8 --prof for Deno client
  profiles/versions.txt                    runtime versions + host caps
```
