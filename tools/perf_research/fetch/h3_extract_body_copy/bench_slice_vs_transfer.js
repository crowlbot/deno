// Compare TypedArrayPrototypeSlice (current extractBody behavior) against
// ArrayBuffer.prototype.transfer (proposed architectural replacement).
//
// For each size: 200 runs of 10k iterations. Report median ns/op + range.

const SIZES = [
  { name: "32 B", size: 32 },
  { name: "1 KB", size: 1024 },
  { name: "64 KB", size: 64 * 1024 },
  { name: "1 MB", size: 1024 * 1024 },
  { name: "4 MB", size: 4 * 1024 * 1024 },
];
const ITERS = 10_000;
const RUNS = 12;

function nsPerOp(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const t1 = performance.now();
  return ((t1 - t0) * 1_000_000) / iters;
}

function bench(label, mk, op) {
  const samples = [];
  for (let r = 0; r < RUNS; r++) {
    samples.push(
      nsPerOp(() => {
        const x = mk();
        op(x);
      }, ITERS),
    );
  }
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  const lo = samples[0];
  const hi = samples[samples.length - 1];
  return { label, median, lo, hi };
}

console.log("op,size,median_ns,lo_ns,hi_ns");
for (const { name, size } of SIZES) {
  // sliceCopy (current behavior)
  const slice = bench(
    "slice",
    () => new Uint8Array(size),
    (u8) => u8.slice(),
  );
  // transfer (proposed)
  const xfer = bench(
    "transfer",
    () => new Uint8Array(size),
    (u8) => new Uint8Array(u8.buffer.transfer()),
  );
  console.log(`slice,${name},${slice.median.toFixed(1)},${slice.lo.toFixed(1)},${slice.hi.toFixed(1)}`);
  console.log(`transfer,${name},${xfer.median.toFixed(1)},${xfer.lo.toFixed(1)},${xfer.hi.toFixed(1)}`);
}
