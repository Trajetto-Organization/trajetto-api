import { app } from "./http";
import { env } from "./env";

import { initializeSocketIO, shutdownSocketIO } from "./websocket";
import { initializeWorkers, shutdownWorkers } from "./workers";

async function gracefulShutdown() {
  console.log("Encerrando aplicação...");

  try {
    // Terminate workers first
    await shutdownWorkers();

    // Closes the Redis pub/sub clients from the Socket.IO adapter
    await shutdownSocketIO();

    console.log("Aplicação encerrada com sucesso");
    process.exit(0);
  } catch (error) {
    console.error("Erro ao encerrar aplicação:", error);
    process.exit(1);
  }
}

// Register handlers for termination signals
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

app
  .listen({
    host: "0.0.0.0",
    port: env.PORT,
  })
  .then(async () => {
    console.log(`⚡ server is running on port: ${env.PORT}`);

    // initializeSocketIO is async because it waits for the adapter's Redis
    // pub/sub clients to become ready. Without await, events emitted before
    // the adapter connects would stay only in this instance's in-memory
    // store (not propagated across replicas).
    await initializeSocketIO(app.server);
    console.log("🔌 WebSocket server initialized");
  })
  .catch((err) => {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  });

// Initialize workers before starting the server
initializeWorkers().catch((error) => {
  console.error("❌ Failed to initialize workers:", error);
  process.exit(1);
});
