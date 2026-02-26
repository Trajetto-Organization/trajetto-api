import { Worker } from "node:worker_threads";
import path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { SendWhatsAppProps } from "../jobs/whatsapp-queue";

import { env } from "../env";

class WhatsAppWorkerManager {
  private static instance: WhatsAppWorkerManager;

  private static readonly MAX_RESTART_ATTEMPTS = 5;
  private static readonly BASE_RESTART_DELAY = 10000;

  private workers: Map<string, Worker> = new Map();
  private restartAttempts: Map<string, number> = new Map();

  private pendingResponses: Map<
    string,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  > = new Map();

  private constructor() {
    process.on("SIGINT", this.shutdown.bind(this));
    process.on("SIGTERM", this.shutdown.bind(this));
  }

  public static getInstance(): WhatsAppWorkerManager {
    if (!WhatsAppWorkerManager.instance) {
      WhatsAppWorkerManager.instance = new WhatsAppWorkerManager();
    }
    return WhatsAppWorkerManager.instance;
  }

  public async startWorker(queueName: string): Promise<void> {
    if (this.workers.has(queueName)) {
      return; // Worker already exists for this queue
    }

    return new Promise((resolve, reject) => {
      try {
        const workerPath =
          env.NODE_ENV === "production"
            ? path.resolve(
                process.cwd(),
                "build",
                "workers",
                "whatsapp-worker.js",
              )
            : path.resolve(
                process.cwd(),
                "src",
                "workers",
                "whatsapp-worker.ts",
              );

        console.log(
          `[WhatsAppManager] Iniciando worker com caminho: ${workerPath}`,
        );

        const workerOptions = {
          workerData: {
            queueName,
            environment: env.NODE_ENV,
          },
          ...(env.NODE_ENV !== "production" && { execArgv: ["-r", "tsx"] }),
        };

        const worker = new Worker(workerPath, workerOptions);

        // Configure event handlers
        worker.on("message", (message) => {
          if (message.type === "ready") {
            this.workers.set(queueName, worker);
            this.restartAttempts.set(queueName, 0);

            console.log(
              `[WhatsAppManager] Worker para fila ${queueName} iniciado com sucesso`,
            );
            resolve();
          } else if (message.type === "error" && !this.workers.has(queueName)) {
            // If we get an error during initialization
            reject(
              new Error(
                message.error || "Erro desconhecido na inicialização do worker",
              ),
            );
          } else if (message.id && this.pendingResponses.has(message.id)) {
            const { resolve, reject, timeout } = this.pendingResponses.get(
              message.id,
            )!;
            clearTimeout(timeout);
            this.pendingResponses.delete(message.id);

            if (message.type === "error") {
              reject(new Error(message.error));
            } else {
              resolve(message);
            }
          }
        });

        worker.on("error", (err) => {
          console.error(
            `[WhatsAppManager] Erro no worker para fila ${queueName}:`,
            err,
          );
          this.workers.delete(queueName);

          // If the error occurs during initialization, we reject the promise.
          if (!this.workers.has(queueName)) {
            reject(err);
          }

          this.scheduleRestart(queueName);
        });

        worker.on("exit", (code) => {
          console.log(
            `[WhatsAppManager] Worker para fila ${queueName} encerrou com código ${code}`,
          );
          this.workers.delete(queueName);

          // Try restarting only if it is not a deliberate shutdown (code 0)
          if (code !== 0) {
            this.scheduleRestart(queueName);
          }
        });

        // If you do not receive the 'ready' message within 45 seconds, we consider the boot to have failed.
        const initTimeout = setTimeout(() => {
          reject(
            new Error(`Timeout ao inicializar worker para fila ${queueName}`),
          );
          worker.terminate();
        }, 45000); // Longer timeout for WhatsApp worker initialization

        // Remove timeout if worker is ready
        worker.once("message", (message) => {
          if (message.type === "ready") {
            clearTimeout(initTimeout);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private scheduleRestart(queueName: string): void {
    const attempts = (this.restartAttempts.get(queueName) || 0) + 1;
    this.restartAttempts.set(queueName, attempts);

    if (attempts > WhatsAppWorkerManager.MAX_RESTART_ATTEMPTS) {
      console.error(
        `[WhatsAppManager] Worker para fila ${queueName} excedeu o limite de ${WhatsAppWorkerManager.MAX_RESTART_ATTEMPTS} tentativas de reinício. Desistindo.`,
      );
      return;
    }

    const delay =
      WhatsAppWorkerManager.BASE_RESTART_DELAY * Math.pow(2, attempts - 1);
    console.log(
      `[WhatsAppManager] Tentando reiniciar worker para fila ${queueName} (tentativa ${attempts}/${WhatsAppWorkerManager.MAX_RESTART_ATTEMPTS}) em ${delay / 1000}s...`,
    );

    setTimeout(() => {
      this.startWorker(queueName).catch((err) => {
        console.error(
          `[WhatsAppManager] Falha ao reiniciar worker para fila ${queueName}:`,
          err,
        );
      });
    }, delay);
  }

  public async enqueueWhatsApp(
    queueName: string,
    data: SendWhatsAppProps,
    timeout: number = 60000, // Longer timeout for WhatsApp operations
  ): Promise<void> {
    if (!this.workers.has(queueName)) {
      await this.startWorker(queueName);
    }

    const worker = this.workers.get(queueName)!;
    const messageId = uuidv4();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingResponses.has(messageId)) {
          this.pendingResponses.delete(messageId);
          reject(
            new Error(`Timeout ao processar WhatsApp para fila ${queueName}`),
          );
        }
      }, timeout);

      this.pendingResponses.set(messageId, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      worker.postMessage({
        type: "enqueueWhatsApp",
        data,
        id: messageId,
      });
    });
  }

  public async shutdown(): Promise<void> {
    console.log(
      "[WhatsAppManager] Iniciando desligamento dos workers de WhatsApp...",
    );

    const shutdownPromises = Array.from(this.workers.entries()).map(
      async ([queueName, worker]) => {
        return new Promise<void>((resolve, reject) => {
          const messageId = uuidv4();
          const timeoutId = setTimeout(() => {
            console.log(
              `[WhatsAppManager] Timeout ao encerrar worker para fila ${queueName}, forçando término...`,
            );

            worker.terminate();
            this.workers.delete(queueName);

            resolve();
          }, 15000); // Longer timeout for WhatsApp worker shutdown

          this.pendingResponses.set(messageId, {
            resolve: () => {
              clearTimeout(timeoutId);
              this.workers.delete(queueName);

              resolve();
            },
            reject: (err: any) => {
              clearTimeout(timeoutId);
              console.error(
                `[WhatsAppManager] Erro ao encerrar worker para fila ${queueName}:`,
                err,
              );

              worker.terminate();
              this.workers.delete(queueName);

              resolve(); // We decided to continue with the shutdown anyway.
            },
            timeout: timeoutId,
          });

          worker.postMessage({
            type: "shutdown",
            id: messageId,
          });
        });
      },
    );

    await Promise.all(shutdownPromises);
    console.log(
      "[WhatsAppManager] Todos os workers de WhatsApp foram encerrados",
    );
  }
}

export default WhatsAppWorkerManager;
