import { Worker } from "node:worker_threads";
import path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { SendEmailProps } from "../jobs/email-queue";

import { env } from "../env";

class EmailWorkerManager {
  private static instance: EmailWorkerManager;

  private workers: Map<string, Worker> = new Map();
  private pendingResponses: Map<
    string,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  > = new Map();

  private constructor() {
    process.on("SIGINT", this.shutdown.bind(this));
    process.on("SIGTERM", this.shutdown.bind(this));
  }

  public static getInstance(): EmailWorkerManager {
    if (!EmailWorkerManager.instance) {
      EmailWorkerManager.instance = new EmailWorkerManager();
    }
    return EmailWorkerManager.instance;
  }

  public async startWorker(queueName: string): Promise<void> {
    if (this.workers.has(queueName)) {
      return; // Worker already exists for this queue
    }

    return new Promise((resolve, reject) => {
      try {
        const workerPath =
          env.NODE_ENV === "production"
            ? path.resolve(process.cwd(), "build", "workers", "email-worker.js")
            : path.resolve(process.cwd(), "src", "workers", "email-worker.ts");

        console.log(`[Manager] Iniciando worker com caminho: ${workerPath}`);

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
            console.log(
              `[Manager] Worker para fila ${queueName} iniciado com sucesso`,
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
            `[Manager] Erro no worker para fila ${queueName}:`,
            err,
          );
          this.workers.delete(queueName);

          // If the error occurs during initialization, we reject the promise.
          if (!this.workers.has(queueName)) {
            reject(err);
          }

          // Try restarting the worker after a delay
          setTimeout(() => {
            console.log(
              `[Manager] Tentando reiniciar worker para fila ${queueName}...`,
            );
            this.startWorker(queueName).catch((err) => {
              console.error(
                `[Manager] Falha ao reiniciar worker para fila ${queueName}:`,
                err,
              );
            });
          }, 5000);
        });

        worker.on("exit", (code) => {
          console.log(
            `[Manager] Worker para fila ${queueName} encerrou com código ${code}`,
          );
          this.workers.delete(queueName);

          // Try restarting only if it is not a deliberate shutdown (code 0)
          if (code !== 0) {
            setTimeout(() => {
              console.log(
                `[Manager] Tentando reiniciar worker para fila ${queueName} após saída...`,
              );
              this.startWorker(queueName).catch((err) => {
                console.error(
                  `[Manager] Falha ao reiniciar worker para fila ${queueName}:`,
                  err,
                );
              });
            }, 5000);
          }
        });

        // If you do not receive the 'ready' message within 30 seconds, we consider the boot to have failed.
        const initTimeout = setTimeout(() => {
          reject(
            new Error(`Timeout ao inicializar worker para fila ${queueName}`),
          );
          worker.terminate();
        }, 30000);

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

  public async enqueueEmail(
    queueName: string,
    data: SendEmailProps,
    timeout: number = 30000,
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
            new Error(`Timeout ao processar email para fila ${queueName}`),
          );
        }
      }, timeout);

      this.pendingResponses.set(messageId, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      worker.postMessage({
        type: "enqueueEmail",
        data,
        id: messageId,
      });
    });
  }

  public async shutdown(): Promise<void> {
    console.log("[Manager] Iniciando desligamento dos workers de email...");

    const shutdownPromises = Array.from(this.workers.entries()).map(
      async ([queueName, worker]) => {
        return new Promise<void>((resolve, reject) => {
          const messageId = uuidv4();
          const timeoutId = setTimeout(() => {
            console.log(
              `[Manager] Timeout ao encerrar worker para fila ${queueName}, forçando término...`,
            );

            worker.terminate();
            this.workers.delete(queueName);

            resolve();
          }, 10000);

          this.pendingResponses.set(messageId, {
            resolve: () => {
              clearTimeout(timeoutId);
              this.workers.delete(queueName);

              resolve();
            },
            reject: (err: any) => {
              clearTimeout(timeoutId);
              console.error(
                `[Manager] Erro ao encerrar worker para fila ${queueName}:`,
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
    console.log("[Manager] Todos os workers de email foram encerrados");
  }
}

export default EmailWorkerManager;
