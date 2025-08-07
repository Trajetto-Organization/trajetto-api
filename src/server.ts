import "reflect-metadata";
import "./shared";

import { app } from "./http";
import { env } from "./env";

import { initializeSocketIO } from "./websocket";
import { initializeWorkers, shutdownWorkers } from "./workers";

async function gracefulShutdown() {
  console.log("Encerrando aplicação...");

  try {
    // Terminate workers first
    await shutdownWorkers();

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
  .then(() => {
    console.log(`⚡ server is running on port: ${env.PORT}`);

    // Initialize Socket.IO after the server is running
    initializeSocketIO(app.server);
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
