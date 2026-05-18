// Microbench for crypto.subtle + crypto.getRandomValues across realistic
// workloads. Patterns favour the hot paths in real apps:
//
// - HMAC-SHA-256 with reused key (auth token validation)
// - SHA-256 digest of small / large messages
// - AES-GCM encrypt/decrypt of token-sized buffers
// - getRandomValues of small (nonce-sized) and medium (16 KB) buffers
// - randomUUID()
// - importKey HMAC raw (stateless auth roundtrip)
// - deriveBits PBKDF2 (password derivation)

const subtle = crypto.subtle;
const enc = new TextEncoder();

const ITERS_FAST = 200_000;
const ITERS_MED = 20_000;
const ITERS_SLOW = 2_000;
const ITERS_HEAVY = 100;

function bench(name, fn, iters) {
  for (let i = 0; i < 5; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = performance.now();
  const ms = t1 - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.log(
    JSON.stringify({ name, iters, ms: ms.toFixed(2), ns_per_op: nsPerOp.toFixed(1) }),
  );
}

async function asyncBench(name, fn, iters) {
  for (let i = 0; i < 3; i++) await fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const t1 = performance.now();
  const ms = t1 - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.log(
    JSON.stringify({ name, iters, ms: ms.toFixed(2), ns_per_op: nsPerOp.toFixed(1) }),
  );
}

// --- getRandomValues ---

// 1. small buffer (UUID-sized, 16 bytes)
const small = new Uint8Array(16);
bench("getrandom_16", () => { crypto.getRandomValues(small); }, ITERS_FAST);

// 2. nonce-sized (32 bytes)
const nonce = new Uint8Array(32);
bench("getrandom_32", () => { crypto.getRandomValues(nonce); }, ITERS_FAST);

// 3. medium (16 KB)
const medium = new Uint8Array(16 * 1024);
bench("getrandom_16k", () => { crypto.getRandomValues(medium); }, ITERS_MED);

// 4. randomUUID
bench("randomUUID", () => { crypto.randomUUID(); }, ITERS_FAST);

// --- Digests (sync calling pattern; subtle.digest is async) ---

const msgShort = enc.encode("hello world");
const msgLong = enc.encode("a".repeat(64 * 1024));

await asyncBench("digest_sha256_short", async () => {
  await subtle.digest("SHA-256", msgShort);
}, ITERS_MED);

await asyncBench("digest_sha256_64k", async () => {
  await subtle.digest("SHA-256", msgLong);
}, ITERS_SLOW);

await asyncBench("digest_sha1_short", async () => {
  await subtle.digest("SHA-1", msgShort);
}, ITERS_MED);

// --- HMAC ---

// importKey HMAC raw (stateless auth pattern: import a shared secret per request)
const hmacKeyBytes = new Uint8Array(32).fill(0x42);

await asyncBench("import_hmac_raw", async () => {
  await subtle.importKey("raw", hmacKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}, ITERS_SLOW);

// Reused HMAC key — typical "verify many tokens with the same key"
const hmacKey = await subtle.importKey(
  "raw",
  hmacKeyBytes,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

await asyncBench("hmac_sign_reused", async () => {
  await subtle.sign("HMAC", hmacKey, msgShort);
}, ITERS_MED);

const hmacSig = new Uint8Array(await subtle.sign("HMAC", hmacKey, msgShort));
await asyncBench("hmac_verify_reused", async () => {
  await subtle.verify("HMAC", hmacKey, hmacSig, msgShort);
}, ITERS_MED);

// --- AES-GCM ---

const aesKey = await subtle.importKey(
  "raw",
  new Uint8Array(32).fill(0x99),
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"],
);

const aesIv = new Uint8Array(12).fill(0x07);
const aesPlain = enc.encode("a".repeat(256));

await asyncBench("aes_gcm_encrypt_256", async () => {
  await subtle.encrypt({ name: "AES-GCM", iv: aesIv }, aesKey, aesPlain);
}, ITERS_MED);

const aesCipher = new Uint8Array(
  await subtle.encrypt({ name: "AES-GCM", iv: aesIv }, aesKey, aesPlain),
);

await asyncBench("aes_gcm_decrypt_256", async () => {
  await subtle.decrypt({ name: "AES-GCM", iv: aesIv }, aesKey, aesCipher);
}, ITERS_MED);

// --- PBKDF2 (deliberately heavy; small iters) ---

const pbkdfKey = await subtle.importKey(
  "raw",
  enc.encode("password"),
  { name: "PBKDF2" },
  false,
  ["deriveBits"],
);

await asyncBench("pbkdf2_sha256_10k", async () => {
  await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations: 10000, salt: aesIv },
    pbkdfKey,
    256,
  );
}, ITERS_HEAVY);
