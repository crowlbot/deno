// Microbench for structuredClone across realistic payload shapes.
//
// Focuses on hot patterns we see in user code:
// - small primitives (cheap; serialize fast path)
// - small object literal {foo:1, bar:'baz'} (most common case)
// - large nested object (JSON-like config)
// - long flat array of primitives (Array<number>)
// - long flat array of strings
// - Map<string, number>
// - typed array clone (Uint8Array)
// - ArrayBuffer clone (raw)
// - DataView clone
// - mixed object with embedded TypedArrays (file metadata pattern)

const ITERS_PRIM = 1_000_000;
const ITERS_SMALL = 200_000;
const ITERS_MED = 20_000;
const ITERS_LARGE = 200;

function bench(name, fn, iters) {
  for (let i = 0; i < 5; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = performance.now();
  const ms = t1 - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.log(JSON.stringify({ name, iters, ms: ms.toFixed(2), ns_per_op: nsPerOp.toFixed(1) }));
}

// 1. Number primitive (should be near-zero; tests fast path)
bench("clone_number", () => { structuredClone(42); }, ITERS_PRIM);

// 2. Short string
const SHORT_STR = "hello world";
bench("clone_short_string", () => { structuredClone(SHORT_STR); }, ITERS_PRIM);

// 3. Boolean
bench("clone_boolean", () => { structuredClone(true); }, ITERS_PRIM);

// 4. Empty object
bench("clone_empty_obj", () => { structuredClone({}); }, ITERS_SMALL);

// 5. Small object literal (3 fields)
bench("clone_small_obj", () => {
  structuredClone({ a: 1, b: "two", c: true });
}, ITERS_SMALL);

// 6. Medium nested object (JSON-config shape)
const mediumObj = {
  name: "test-app",
  version: "1.2.3",
  description: "A test application",
  dependencies: {
    foo: "^1.0.0",
    bar: "^2.0.0",
    baz: "^3.0.0",
  },
  scripts: {
    start: "deno run main.ts",
    test: "deno test",
  },
  config: {
    port: 8080,
    host: "localhost",
    timeout: 30000,
    retries: 3,
  },
  enabled: true,
};
bench("clone_medium_obj", () => {
  structuredClone(mediumObj);
}, ITERS_MED);

// 7. Long flat array of numbers (1000 items)
const nums = Array.from({ length: 1000 }, (_, i) => i);
bench("clone_array_1000_nums", () => {
  structuredClone(nums);
}, ITERS_MED);

// 8. Long flat array of strings (1000 items)
const strs = Array.from({ length: 1000 }, (_, i) => "item-" + i);
bench("clone_array_1000_strs", () => {
  structuredClone(strs);
}, ITERS_MED);

// 9. Map<string, number> with 100 entries
const map = new Map();
for (let i = 0; i < 100; i++) map.set("k" + i, i);
bench("clone_map_100", () => {
  structuredClone(map);
}, ITERS_MED);

// 10. Small Uint8Array (256 bytes)
const u8_256 = new Uint8Array(256).fill(0x41);
bench("clone_u8_256", () => {
  structuredClone(u8_256);
}, ITERS_SMALL);

// 11. Medium Uint8Array (64 KB)
const u8_64k = new Uint8Array(65536).fill(0x41);
bench("clone_u8_64k", () => {
  structuredClone(u8_64k);
}, ITERS_MED);

// 12. Large Uint8Array (1 MB)
const u8_1m = new Uint8Array(1024 * 1024).fill(0x41);
bench("clone_u8_1m", () => {
  structuredClone(u8_1m);
}, ITERS_LARGE);

// 13. ArrayBuffer 64 KB (no view)
const ab_64k = new ArrayBuffer(65536);
bench("clone_ab_64k", () => {
  structuredClone(ab_64k);
}, ITERS_MED);

// 14. DataView over 64 KB
const dv_64k = new DataView(new ArrayBuffer(65536));
bench("clone_dv_64k", () => {
  structuredClone(dv_64k);
}, ITERS_MED);

// 15. Mixed: object containing a 4 KB Uint8Array (file-metadata shape)
const fileMeta = {
  name: "image.png",
  type: "image/png",
  size: 4096,
  bytes: new Uint8Array(4096),
  modified: new Date(),
};
bench("clone_file_meta", () => {
  structuredClone(fileMeta);
}, ITERS_MED);
