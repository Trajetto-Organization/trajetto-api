import { parentPort, workerData } from "node:worker_threads";
import { WhatsAppQueueProvider } from "../jobs/whatsapp-queue";

import { WhatsAppWorkerData } from "./types";

// Extend the WhatsAppQueueProvider to include close method
interface WhatsAppQueueWithClose extends WhatsAppQueueProvider {
  close(): Promise<void>;
}

// Get WhatsApp provider from environment
// Since we're in another thread, we need to create provider instance directly
import { EvolutionApiProvider } from "../shared/providers/whatsapp-provider/implementations/evolution-api-provider";

// Initialize worker with received data
const { queueName } = workerData as WhatsAppWorkerData;

// Create WhatsApp provider instance (adjust based on your provider)
const whatsAppProvider = new EvolutionApiProvider();

let whatsAppQueue: WhatsAppQueueWithClose;

// Initializes the WhatsApp queue when the worker is started
try {
  console.log(`[WhatsAppWorker] Iniciando worker para fila: ${queueName}`);
  whatsAppQueue = new WhatsAppQueueProvider(
    whatsAppProvider,
    queueName,
  ) as WhatsAppQueueWithClose;

  // Initialize the queue
  whatsAppQueue
    .initialize()
    .then(() => {
      // Inform main thread that worker is ready
      parentPort?.postMessage({ type: "ready", queueName });
    })
    .catch((error) => {
      console.error(
        `[WhatsAppWorker] Erro ao inicializar fila para ${queueName}:`,
        error,
      );
      parentPort?.postMessage({
        type: "error",
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido na inicialização da fila",
      });
    });
} catch (error) {
  console.error(
    `[WhatsAppWorker] Erro ao inicializar worker para fila ${queueName}:`,
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
      case "enqueueWhatsApp": {
        console.log(
          `[WhatsAppWorker] Processando WhatsApp para fila: ${queueName}`,
        );
        try {
          await whatsAppQueue.enqueueWhatsApp(data);
          parentPort?.postMessage({ type: "success", id });
        } catch (whatsAppError) {
          console.error(
            `[WhatsAppWorker] Erro ao enviar WhatsApp:`,
            whatsAppError,
          );
          parentPort?.postMessage({
            type: "error",
            error:
              whatsAppError instanceof Error
                ? whatsAppError.message
                : "Erro desconhecido no envio de WhatsApp",
            id,
          });
        }
        break;
      }

      case "shutdown": {
        console.log(
          `[WhatsAppWorker] Encerrando worker para fila: ${queueName}`,
        );
        try {
          if (whatsAppQueue.close) {
            await whatsAppQueue.close();
          }
          parentPort?.postMessage({ type: "closed", id });
        } catch (shutdownError) {
          console.error(
            `[WhatsAppWorker] Erro ao encerrar fila:`,
            shutdownError,
          );
          parentPort?.postMessage({
            type: "error",
            error:
              shutdownError instanceof Error
                ? shutdownError.message
                : "Erro desconhecido ao encerrar",
            id,
          });
        }

        process.exit(0);
      }
      default:
        throw new Error(`Tipo de mensagem desconhecido: ${type}`);
    }
  } catch (error) {
    console.error(`[WhatsAppWorker] Erro ao processar mensagem:`, error);
    parentPort?.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      id: message.id,
    });
  }
});

// Handling uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[WhatsAppWorker] Erro não capturado:", error);
  parentPort?.postMessage({
    type: "error",
    error: `Erro não capturado: ${error.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[WhatsAppWorker] Rejeição não tratada:", reason);
  parentPort?.postMessage({
    type: "error",
    error: `Rejeição não tratada: ${reason}`,
  });
});
