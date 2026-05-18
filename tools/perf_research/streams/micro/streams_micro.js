// Microbench for ReadableStream / WritableStream / TransformStream.
//
// Covers realistic streaming workloads:
// - pipeThrough a TransformStream that doubles bytes (e.g. compression-like passthrough)
// - pipeTo a WritableStream that consumes (sink) — async iterator path
// - construct/start/cancel cycle
// - BYOB read into caller-provided buffer
// - chunk dispatch via DefaultController.enqueue at high rate

const ITERS_PIPE = 200;
const ITERS_OPS = 50_000;

function bench(name, fn, iters) {
  for (let i = 0; i < 5; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = performance.now();
  const ms = t1 - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.log(JSON.stringify({ name, iters, ms: ms.toFixed(2), ns_per_op: nsPerOp.toFixed(1) }));
}

async function asyncBench(name, fn, iters) {
  for (let i = 0; i < 3; i++) await fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const t1 = performance.now();
  const ms = t1 - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.log(JSON.stringify({ name, iters, ms: ms.toFixed(2), ns_per_op: nsPerOp.toFixed(1) }));
}

// 1: Construct empty ReadableStream
bench("rs_construct_empty", () => {
  new ReadableStream();
}, ITERS_OPS);

// 2: Construct ReadableStream with start() that enqueues 1 chunk + closes
bench("rs_construct_one_chunk", () => {
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
}, ITERS_OPS);

// 3: Construct TransformStream (identity)
bench("ts_construct", () => {
  new TransformStream();
}, ITERS_OPS);

// 4: Read 256 chunks of 4 KB via getReader().read()
const chunkBytes = new Uint8Array(4096).fill(0x41);
const CHUNKS = 256;

await asyncBench("rs_read_256x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < CHUNKS; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  const reader = rs.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 5: pipeThrough identity TransformStream (256 chunks)
await asyncBench("rs_pipethrough_identity_256x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < CHUNKS; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  const ts = new TransformStream();
  const out = rs.pipeThrough(ts);
  const reader = out.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 6: pipeThrough TransformStream that copies the chunk byte-by-byte (worst case)
await asyncBench("rs_pipethrough_copy_256x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < CHUNKS; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  const ts = new TransformStream({
    transform(chunk, controller) {
      // Force a copy (the most common transform shape)
      controller.enqueue(new Uint8Array(chunk));
    },
  });
  const out = rs.pipeThrough(ts);
  const reader = out.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 7: pipeTo a WritableStream sink
await asyncBench("rs_pipeto_sink_256x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < CHUNKS; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  let total = 0;
  const ws = new WritableStream({
    write(chunk) { total += chunk.byteLength; },
  });
  await rs.pipeTo(ws);
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 8: BYOB read via 'bytes' stream — 256 reads of 4 KB
await asyncBench("rs_byob_read_256x4k", async () => {
  let i = 0;
  const rs = new ReadableStream({
    type: "bytes",
    pull(controller) {
      if (i < CHUNKS) {
        const v = controller.byobRequest?.view;
        if (v) {
          v.set(chunkBytes.subarray(0, Math.min(v.byteLength, 4096)));
          controller.byobRequest.respond(Math.min(v.byteLength, 4096));
        } else {
          controller.enqueue(chunkBytes);
        }
        i++;
      } else {
        controller.close();
      }
    },
  });
  const reader = rs.getReader({ mode: "byob" });
  let total = 0;
  while (true) {
    const buf = new Uint8Array(4096);
    const { value, done } = await reader.read(buf);
    if (done) break;
    total += value.byteLength;
  }
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 9: async iterator over ReadableStream
await asyncBench("rs_async_iter_256x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < CHUNKS; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  let total = 0;
  for await (const chunk of rs) total += chunk.byteLength;
  if (total < 0) console.log(total);
}, ITERS_PIPE);

// 10: tee a stream then consume both halves
await asyncBench("rs_tee_consume_both_64x4k", async () => {
  const rs = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 64; i++) controller.enqueue(chunkBytes);
      controller.close();
    },
  });
  const [a, b] = rs.tee();
  const ra = a.getReader();
  const rb = b.getReader();
  while (true) {
    const r = await ra.read();
    if (r.done) break;
  }
  while (true) {
    const r = await rb.read();
    if (r.done) break;
  }
}, ITERS_PIPE);
