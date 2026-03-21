import { parentPort, workerData } from "node:worker_threads";

import { AIVerificationQueueProvider } from "../jobs/ai-verification-queue";
import { AIVerificationWorkerData } from "./types";

// Initialize worker with received data
const { queueName } = workerData as AIVerificationWorkerData;

let verificationQueue: AIVerificationQueueProvider;
let initialized = false;

try {
  console.log(
    `[AIVerificationWorker] Iniciando worker para fila: ${queueName}`,
  );
  verificationQueue = new AIVerificationQueueProvider(queueName);

  // Set up WebSocket relay: when the queue wants to emit a WS event,
  // relay it back to the main thread (which has access to Socket.IO)
  verificationQueue.onWebSocketEmit = (userId: string, event: any) => {
    parentPort?.postMessage({
      type: "websocket_emit",
      data: { userId, event },
    });
  };

  // Initialize the queue (connects to RabbitMQ, sets up consumer)
  verificationQueue
    .initialize()
    .then(() => {
      initialized = true;
      parentPort?.postMessage({ type: "ready", queueName });
    })
    .catch((error) => {
      console.error(`[AIVerificationWorker] Erro ao inicializar queue:`, error);
      parentPort?.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    });
} catch (error) {
  console.error(
    `[AIVerificationWorker] Erro ao inicializar worker para fila ${queueName}:`,
    error,
  );
  parentPort?.postMessage({
    type: "error",
    error:
      error instanceof Error
        ? error.message
        : "Erro desconhecido na inicialização",
  });
}

// Process messages from the main thread
parentPort?.on("message", async (message) => {
  try {
    const { type, data, id } = message;

    switch (type) {
      case "enqueueVerification": {
        if (!initialized) {
          parentPort?.postMessage({
            type: "error",
            error: "Worker ainda não inicializado",
            id,
          });

          break;
        }

        console.log(
          `[AIVerificationWorker] Enfileirando verificação: ${data.type} para ${data.recordId}`,
        );
        try {
          await verificationQueue.enqueueVerification(data);
          parentPort?.postMessage({ type: "success", id });
        } catch (enqueueError) {
          console.error(
            `[AIVerificationWorker] Erro ao enfileirar:`,
            enqueueError,
          );

          parentPort?.postMessage({
            type: "error",
            error:
              enqueueError instanceof Error
                ? enqueueError.message
                : "Erro desconhecido ao enfileirar",
            id,
          });
        }

        break;
      }

      case "shutdown": {
        console.log(
          `[AIVerificationWorker] Encerrando worker para fila: ${queueName}`,
        );

        await verificationQueue.close();

        parentPort?.postMessage({ type: "closed", id });
        process.exit(0);
      }

      default:
        throw new Error(`Tipo de mensagem desconhecido: ${type}`);
    }
  } catch (error) {
    console.error(`[AIVerificationWorker] Erro ao processar mensagem:`, error);
    parentPort?.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      id: message.id,
    });
  }
});

// Handling uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[AIVerificationWorker] Erro não capturado:", error);
  parentPort?.postMessage({
    type: "error",
    error: `Erro não capturado: ${error.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[AIVerificationWorker] Rejeição não tratada:", reason);
  parentPort?.postMessage({
    type: "error",
    error: `Rejeição não tratada: ${reason}`,
  });
});
