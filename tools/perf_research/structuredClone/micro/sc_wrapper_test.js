// Demonstrates that the slowdown is V8 failing to inline the structuredClone
// function body. Wrapping with an external fast-path identical to what's
// inside structuredClone reduces the primitive call cost ~100x in Deno.

const ITERS = 5_000_000;
const realSC = structuredClone;

function wrappedSC(value, options) {
  if (options === undefined) {
    if (value === null) return value;
    const t = typeof value;
    if (t !== "object" && t !== "function" && t !== "symbol") {
      return value;
    }
  }
  return realSC(value, options);
}

function timeIt(name, fn) {
  for (let i = 0; i < 100_000; i++) fn(i);
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < ITERS; i++) sink += fn(i);
  const t1 = performance.now();
  console.log(JSON.stringify({ name, ms: (t1 - t0).toFixed(2), ns: ((t1 - t0) * 1e6 / ITERS).toFixed(1) }));
}

timeIt("realSC_42", realSC);
timeIt("wrappedSC_42", wrappedSC);
