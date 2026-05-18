// Echo WebSocket server. Run with Deno; used as the reference server
// against which Node / Bun / Deno clients are compared.
//
// Started by the bench driver. Reads PORT from argv[2].

const port = parseInt(Deno.args[0] || "9001", 10);

Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("ws-only", { status: 400 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = "arraybuffer";
  socket.onmessage = (e) => {
    try {
      socket.send(e.data);
    } catch (_) {
      // peer gone
    }
  };
  socket.onclose = () => {};
  socket.onerror = () => {};
  return response;
});

console.error("ready");
