// Macro: stream a 16 MB body through a TransformStream that does
// a real-world transform (uppercase ASCII), then drain via pipeTo.
// Repeat to amortize startup and produce stable ratios.

const SIZE_MB = 16;
const CHUNK = 16 * 1024; // 16 KB chunks
const BUF = new Uint8Array(CHUNK).fill(0x61); // 'a'

const ITERS = 20;

async function run() {
  for (let warm = 0; warm < 2; warm++) await once();
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) await once();
  const t1 = performance.now();
  const totalMB = SIZE_MB * ITERS;
  const mbps = (totalMB * 1000) / (t1 - t0);
  console.log(
    JSON.stringify({
      name: "macro_pipethrough_uppercase_16mb",
      iters: ITERS,
      ms_total: (t1 - t0).toFixed(2),
      mb_per_s: mbps.toFixed(1),
    }),
  );
}

async function once() {
  const total = SIZE_MB * 1024 * 1024;
  let written = 0;

  const rs = new ReadableStream({
    pull(controller) {
      if (written >= total) {
        controller.close();
        return;
      }
      controller.enqueue(BUF);
      written += CHUNK;
    },
  });

  const ts = new TransformStream({
    transform(chunk, controller) {
      // uppercase ASCII into a new buffer (most common transform shape)
      const out = new Uint8Array(chunk.byteLength);
      for (let i = 0; i < chunk.byteLength; i++) {
        const b = chunk[i];
        out[i] = (b >= 0x61 && b <= 0x7a) ? b - 0x20 : b;
      }
      controller.enqueue(out);
    },
  });

  let sink = 0;
  const ws = new WritableStream({ write(chunk) { sink += chunk.byteLength; } });

  await rs.pipeThrough(ts).pipeTo(ws);
  if (sink !== total) throw new Error("size mismatch " + sink + " vs " + total);
}

await run();
