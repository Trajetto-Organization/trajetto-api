/**
 * Does a panel socket stay up behind the real edge (Cloudflare + Traefik)?
 *
 * Traefik's `readTimeout` (120 s in production, 60 s by default in v3) bounds
 * RECEIVING a request. Locally, Traefik 3.7.13 did not cut an already
 * upgraded WebSocket (measured with 5 s and the connection held 15 s). This
 * asks the same question of staging, over the whole path: open the socket,
 * sit idle for HOLD_MINUTES and count the drops. No automatic reconnection:
 * a drop is a drop.
 *
 *   LOAD_SOCKET_URL=https://<staging api> LOAD_SOCKET_TOKEN=<manager token> \
 *     HOLD_MINUTES=5 node tests/load/socket-hold.mjs
 */
import { loadSocketClient } from "./lib/socket-client.mjs";

const url = process.env.LOAD_SOCKET_URL;
const token = process.env.LOAD_SOCKET_TOKEN;
const minutes = Number(process.env.HOLD_MINUTES || 5);

if (!url || !token) {
  console.error("Defina LOAD_SOCKET_URL e LOAD_SOCKET_TOKEN.");
  process.exit(2);
}

const io = await loadSocketClient();
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;

const socket = io(url, {
  auth: { token },
  transports: ["websocket"],
  reconnection: false,
});

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: true }), minutes * 60_000);

  socket.on("connect", () => console.log(`  conectado (${elapsed()})`));

  socket.on("connect_error", (error) => {
    clearTimeout(timer);
    resolve({ ok: false, reason: `handshake recusado: ${error.message}` });
  });

  socket.on("disconnect", (reason) => {
    clearTimeout(timer);
    resolve({ ok: false, reason: `caiu depois de ${elapsed()}: ${reason}` });
  });
});

socket.disconnect();

if (!outcome.ok) {
  console.error(`  FALHOU: ${outcome.reason}`);
  process.exit(1);
}

console.log(`  OK: ${minutes} min de pé, sem queda.`);
