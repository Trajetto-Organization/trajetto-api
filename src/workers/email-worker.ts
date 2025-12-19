import { parentPort, workerData } from "node:worker_threads";
import { EmailQueueProvider } from "../jobs/email-queue";

import { EtherealMailProvider } from "../shared/providers/mail-provider/implementations/ethereal-mail-provider";
import { ResendMailProvider } from "../shared/providers/mail-provider/implementations/resend-mail-provider";

import { EmailWorkerData } from "./types";

// Extend the EmailQueueProvider to include close method
interface EmailQueueWithClose extends EmailQueueProvider {
  close(): Promise<void>;
}

// Necessary since we are in another thread and will not have access to the tsyringe container
// Factory function to create mail provider only when needed (lazy loading)
function createMailProvider(environment: EmailWorkerData["environment"]): any {
  switch (environment) {
    case "production":
      return new ResendMailProvider();
    case "test":
      return new EtherealMailProvider();
    case "development":
    default:
      return new EtherealMailProvider();
  }
}

// Initialize worker with received data
const { queueName, environment } = workerData as EmailWorkerData;
const mailProvider = createMailProvider(environment || "development");

let emailQueue: EmailQueueWithClose;

// Initializes the email queue when the worker is started
try {
  console.log(`[Worker] Iniciando worker para fila: ${queueName}`);
  emailQueue = new EmailQueueProvider(
    mailProvider,
    queueName,
  ) as EmailQueueWithClose;

  // Inform main thread that worker is ready
  parentPort?.postMessage({ type: "ready", queueName });
} catch (error) {
  console.error(
    `[Worker] Erro ao inicializar worker para fila ${queueName}:`,
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
      case "enqueueEmail": {
        console.log(`[Worker] Processando email para fila: ${queueName}`);
        try {
          await emailQueue.enqueueEmail(data);
          parentPort?.postMessage({ type: "success", id });
        } catch (emailError) {
          console.error(`[Worker] Erro ao enviar email:`, emailError);
          parentPort?.postMessage({
            type: "error",
            error:
              emailError instanceof Error
                ? emailError.message
                : "Erro desconhecido no envio de email",
            id,
          });
        }
        break;
      }

      case "shutdown": {
        console.log(`[Worker] Encerrando worker para fila: ${queueName}`);
        try {
          await emailQueue.close();
          parentPort?.postMessage({ type: "closed", id });
        } catch (shutdownError) {
          console.error(`[Worker] Erro ao encerrar fila:`, shutdownError);
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
    console.error(`[Worker] Erro ao processar mensagem:`, error);
    parentPort?.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      id: message.id,
    });
  }
});

// Handling uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[Worker] Erro não capturado:", error);
  parentPort?.postMessage({
    type: "error",
    error: `Erro não capturado: ${error.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[Worker] Rejeição não tratada:", reason);
  parentPort?.postMessage({
    type: "error",
    error: `Rejeição não tratada: ${reason}`,
  });
});
