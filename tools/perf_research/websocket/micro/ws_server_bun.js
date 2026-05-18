// Echo WebSocket server for Bun. Same shape as ws_server.js.

const port = parseInt(Bun.argv[2] || "9002", 10);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("ws-only", { status: 400 });
  },
  websocket: {
    message(ws, message) {
      ws.send(message);
    },
  },
});

console.error("ready");
