#!/usr/bin/env bash
# Run a Deno.serve workload with V8 --prof; drive it with autocannon for ~12s;
# then parse the V8 isolate log into a readable bottom-up attribution. Profile
# artifacts land under tools/perf_research/http-serve/profiles/<workload>/.
#
# Usage: run_prof.sh <workload> [duration_seconds] [concurrency]
#   workload: name of a server under servers/ (without .js)
#   duration_seconds: autocannon --duration (default 12)
#   concurrency: autocannon --connections (default 32)

set -euo pipefail
WORKLOAD="${1:?usage: run_prof.sh <workload> [duration] [concurrency]}"
DURATION="${2:-12}"
CONCURRENCY="${3:-32}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
DENO="${DENO_BIN:-$ROOT/../../../target/release/deno}"
SRV="$ROOT/servers/$WORKLOAD.js"
[ -f "$SRV" ] || { echo "server not found: $SRV" >&2; exit 1; }

OUTDIR="$ROOT/profiles/$WORKLOAD"
mkdir -p "$OUTDIR"
cd "$OUTDIR"
rm -f isolate-*.log

PORT=$((8400 + RANDOM % 100))
echo "starting server: $WORKLOAD on port $PORT"
"$DENO" run --allow-net --v8-flags=--prof "$SRV" "$PORT" &
SRVPID=$!
trap 'kill $SRVPID 2>/dev/null; wait 2>/dev/null || true' EXIT INT

until curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/"; do sleep 0.2; done
echo "warmup..."
~/node22/bin/node /tmp/node_modules/.bin/autocannon \
  -c "$CONCURRENCY" -d 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true

echo "measure: $CONCURRENCY connections x ${DURATION}s"
RESULT_JSON=$(~/node22/bin/node /tmp/node_modules/.bin/autocannon \
  -c "$CONCURRENCY" -d "$DURATION" --json "http://127.0.0.1:$PORT/" 2>&1)
echo "$RESULT_JSON" > "$OUTDIR/autocannon.json"
echo "rps: $(echo "$RESULT_JSON" | ~/node22/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.requests.average.toFixed(0))})')"

kill $SRVPID
wait 2>/dev/null || true

echo "tick processing the V8 prof log..."
ISO=$(ls -1t isolate-*.log 2>/dev/null | head -1)
if [ -z "$ISO" ]; then
  echo "no isolate log produced — check that --v8-flags=--prof was honored" >&2
  exit 2
fi
"$DENO" --v8-flags=--prof-process "$ISO" > "$OUTDIR/prof.txt" 2>&1 || true

echo "wrote:"
echo "  $OUTDIR/autocannon.json"
echo "  $OUTDIR/prof.txt"
echo "  $OUTDIR/$ISO"
