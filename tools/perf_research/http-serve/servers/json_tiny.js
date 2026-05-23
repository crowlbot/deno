// Tiny JSON server — the canonical "Deno.serve fast path" workload.
// Each request: parse method+url from request line, look up headers (none),
// construct a small Response with a JSON body and a Content-Type header.
// Profile to attribute JS-side cost to ext/http vs ext/fetch internals.

const PORT = Number(Deno.args[0] ?? 8401);

Deno.serve({ port: PORT }, () => {
  return new Response(JSON.stringify({ ok: true, ts: 1 }), {
    headers: { "content-type": "application/json" },
  });
});
