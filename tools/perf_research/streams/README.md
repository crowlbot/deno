# streams — perf research (in progress)

Macro-level performance research on Deno's implementation of `ReadableStream`,
`WritableStream`, and `TransformStream`.

**Status:** scaffolding only. The microbench script has been written but
benchmarks have not been run yet (session was transferred to a new machine
mid-tick). To resume:

```bash
cargo build --release --bin deno

# Run microbench in all three runtimes:
for rt in deno node bun; do
  case $rt in
    deno) ./target/release/deno run -A --no-prompt tools/perf_research/streams/micro/streams_micro.js ;;
    node) node tools/perf_research/streams/micro/streams_micro.js ;;
    bun)  bun  tools/perf_research/streams/micro/streams_micro.js ;;
  esac
done

# V8 prof (perf/samply blocked by paranoid=3 in the original container):
mkdir -p /tmp/streamsprof && cd /tmp/streamsprof
$DENO_BIN run -A --no-prompt --v8-flags=--prof,--no-logfile-per-isolate \
    /path/to/tools/perf_research/streams/micro/streams_micro.js
node --prof-process v8.log > /path/to/profiles/streams_micro.prof.txt
```

## Layout

```
micro/streams_micro.js   10 ops: construct, read 256×4 KB, pipeThrough identity
                          + copy, pipeTo sink, BYOB read, async iter, tee.
profiles/                will hold V8 prof artifacts once benches run.
```

Follow the pattern of `perf-research/fetch` (PR #1 on `crowlbot/deno`),
`perf-research/url` (#2), and `perf-research/text-encoding` (#3) for the
report shape: ratios table, V8 prof excerpt, file:line attribution,
ranked architectural hypotheses.
