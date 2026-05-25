/**
 * AURA WebSocket Hub
 * Standalone WS server on port 5001 (localhost only).
 * voice.py + other services POST to /api/events/push → broadcast to UI.
 */

const { WebSocketServer } = require("ws");

let wss = null;

const start = (port = 5001) => {
  if (wss) return; // already started

  wss = new WebSocketServer({ port, host: "127.0.0.1" });

  wss.on("listening", () => {
    console.log(`[WS Hub] Listening on ws://127.0.0.1:${port}`);
  });

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log("[WS Hub] Client connected from", ip);

    // Send initial state
    ws.send(JSON.stringify({ type: "connected", message: "AURA WebSocket ready" }));

    ws.on("error", (err) => console.warn("[WS Hub] Client error:", err.message));
    ws.on("close",  ()    => console.log("[WS Hub] Client disconnected"));
  });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[WS Hub] Port ${port} in use — skipping WS hub start.`);
    } else {
      console.error("[WS Hub] Error:", err.message);
    }
  });
};

const broadcast = (event) => {
  if (!wss) return 0;
  const msg = typeof event === "string" ? event : JSON.stringify(event);
  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(msg);
        count++;
      } catch (err) {
        // One broken client must not stop delivery to the rest
        console.warn("[WS Hub] client.send() failed (client may have disconnected):", err.message);
      }
    }
  });
  return count;
};

const getClientCount = () => {
  if (!wss) return 0;
  return [...wss.clients].filter((c) => c.readyState === 1).length;
};

module.exports = { start, broadcast, getClientCount };
