// Client-side WebSocket bench: send N text + binary messages of given
// size and measure throughput. Universal WebSocket API across Deno,
// Node 22+, and Bun.

const PORT = process?.env?.PORT || Deno?.env?.get?.("PORT") || "9001";
const URL = `ws://127.0.0.1:${PORT}/`;

function once(name, count, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    if (typeof payload === "object" && payload instanceof Uint8Array) {
      ws.binaryType = "arraybuffer";
    }
    let recv = 0;
    let t0;
    ws.onopen = () => {
      t0 = performance.now();
      for (let i = 0; i < count; i++) ws.send(payload);
    };
    ws.onmessage = () => {
      recv++;
      if (recv === count) {
        const t1 = performance.now();
        const ms = t1 - t0;
        const usPerOp = (ms * 1000) / count;
        console.log(
          JSON.stringify({
            name,
            count,
            ms: ms.toFixed(2),
            us_per_op: usPerOp.toFixed(2),
            msgs_per_s: ((count * 1000) / ms).toFixed(0),
          }),
        );
        ws.close();
        resolve();
      }
    };
    ws.onerror = (e) => reject(e);
  });
}

const warm = 200;
const COUNT_SMALL = 50_000;
const COUNT_MED = 10_000;
const COUNT_LARGE = 500;

const smallText = "hello world";
const smallBin = new Uint8Array(32).fill(0x42);
const medBin = new Uint8Array(4096).fill(0x42);
const largeBin = new Uint8Array(64 * 1024).fill(0x42);

await once("warmup", warm, smallText);
await once("client_text_11", COUNT_SMALL, smallText);
await once("client_bin_32", COUNT_SMALL, smallBin);
await once("client_bin_4k", COUNT_MED, medBin);
await once("client_bin_64k", COUNT_LARGE, largeBin);
