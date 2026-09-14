import { app } from "./http";
import { env } from "./env";

import { initializeSocketIO, shutdownSocketIO } from "./websocket";
import { initializeWorkers, shutdownWorkers } from "./workers";

/**
 * A second SIGTERM (Swarm sends one, then SIGKILL) must not restart the
 * sequence and double-close everything mid-flight.
 */
let shuttingDown = false;

/** Hard ceiling for the whole sequence — stays under the 40s stop grace. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("Encerrando aplicação...");

  // If any step hangs (an SMTP socket, a stuck Postgres claim), the process
  // still goes away on its own instead of waiting for SIGKILL.
  const watchdog = setTimeout(() => {
    console.error("Shutdown excedeu o tempo limite, encerrando à força");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  watchdog.unref();

  try {
    // Fastify first: it stops accepting new connections and drains the
    // requests already in flight. Tearing the workers down before that would
    // leave those requests calling into services that no longer exist.
    await app.close();

    await shutdownWorkers();

    // Closes the Redis pub/sub clients from the Socket.IO adapter
    await shutdownSocketIO();

    clearTimeout(watchdog);

    console.log("Aplicação encerrada com sucesso");
    process.exit(0);
  } catch (error) {
    clearTimeout(watchdog);

    console.error("Erro ao encerrar aplicação:", error);
    process.exit(1);
  }
}

// Register handlers for termination signals
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

async function bootstrap() {
  // Workers come up before the listener: the pipeline and the cron scheduler
  // must be running before the first request can enqueue work for them.
  await initializeWorkers();

  await app.listen({
    host: "0.0.0.0",
    port: env.PORT,
  });

  console.log(`⚡ server is running on port: ${env.PORT}`);

  // initializeSocketIO is async because it waits for the adapter's Redis
  // pub/sub clients to become ready. Without await, events emitted before
  // the adapter connects would stay only in this instance's in-memory
  // store (not propagated across replicas).
  await initializeSocketIO(app.server);
  console.log("🔌 WebSocket server initialized");
}

bootstrap().catch((error) => {
  console.error("❌ Error starting server:", error);
  process.exit(1);
});
