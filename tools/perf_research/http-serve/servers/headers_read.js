// Headers-read server — exercises op_http_get_request_headers + Headers
// iteration on the request side. Returns a tiny JSON acknowledgement that
// echoes how many headers were seen and whether a specific one was set.

const PORT = Number(Deno.args[0] ?? 8402);

Deno.serve({ port: PORT }, (req) => {
  let n = 0;
  for (const _ of req.headers) n++;
  const auth = req.headers.get("authorization") ?? "";
  return new Response(JSON.stringify({ n, auth: auth.length }), {
    headers: { "content-type": "application/json" },
  });
});
