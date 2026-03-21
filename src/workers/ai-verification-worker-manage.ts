import { Worker } from "node:worker_threads";
import path from "node:path";

import { v4 as uuidv4 } from "uuid";

import { AIVerificationJobData } from "../jobs/ai-verification-queue";
import { env } from "../env";

class AIVerificationWorkerManager {
  private static instance: AIVerificationWorkerManager;
  private static readonly MAX_RESTART_ATTEMPTS = 5;

  // Longer delay than email worker (5s) — AI operations take longer to initialize.
  private static readonly BASE_RESTART_DELAY = 10000;

  private workers: Map<string, Worker> = new Map();
  private restartAttempts: Map<string, number> = new Map();

  private pendingResponses: Map<
    string,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  > = new Map();

  // Callback for relaying WebSocket events from worker to main thread
  public onWebSocketRelay: ((userId: string, event: any) => void) | null = null;

  private constructor() {
    process.on("SIGINT", this.shutdown.bind(this));
    process.on("SIGTERM", this.shutdown.bind(this));
  }

  public static getInstance(): AIVerificationWorkerManager {
    if (!AIVerificationWorkerManager.instance) {
      AIVerificationWorkerManager.instance = new AIVerificationWorkerManager();
    }

    return AIVerificationWorkerManager.instance;
  }

  public async startWorker(queueName: string): Promise<void> {
    if (this.workers.has(queueName)) return;

    return new Promise((resolve, reject) => {
      try {
        const workerPath =
          env.NODE_ENV === "production"
            ? path.resolve(
                process.cwd(),
                "build",
                "workers",
                "ai-verification-worker.js",
              )
            : path.resolve(
                process.cwd(),
                "src",
                "workers",
                "ai-verification-worker.ts",
              );

        console.log(
          `[AIVerificationManager] Iniciando worker com caminho: ${workerPath}`,
        );

        const workerOptions = {
          workerData: {
            queueName,
            environment: env.NODE_ENV,
          },
          ...(env.NODE_ENV !== "production" && { execArgv: ["-r", "tsx"] }),
        };

        const worker = new Worker(workerPath, workerOptions);

        worker.on("message", (message) => {
          // Handle WebSocket relay from worker
          if (message.type === "websocket_emit") {
            if (this.onWebSocketRelay) {
              this.onWebSocketRelay(message.data.userId, message.data.event);
            }

            return;
          }

          if (message.type === "ready") {
            this.workers.set(queueName, worker);
            this.restartAttempts.set(queueName, 0);

            console.log(
              `[AIVerificationManager] Worker para fila ${queueName} iniciado com sucesso`,
            );
            resolve();
          } else if (message.type === "error" && !this.workers.has(queueName)) {
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
            `[AIVerificationManager] Erro no worker para fila ${queueName}:`,
            err,
          );
          this.workers.delete(queueName);

          if (!this.workers.has(queueName)) {
            reject(err);
          }

          this.scheduleRestart(queueName);
        });

        worker.on("exit", (code) => {
          console.log(
            `[AIVerificationManager] Worker para fila ${queueName} encerrou com código ${code}`,
          );
          this.workers.delete(queueName);

          if (code !== 0) {
            this.scheduleRestart(queueName);
          }
        });

        const initTimeout = setTimeout(() => {
          reject(
            new Error(`Timeout ao inicializar worker para fila ${queueName}`),
          );

          worker.terminate();
        }, 45000); // 45s timeout (AI takes longer to initialize)

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

    if (attempts > AIVerificationWorkerManager.MAX_RESTART_ATTEMPTS) {
      console.error(
        `[AIVerificationManager] Worker para fila ${queueName} excedeu o limite de ${AIVerificationWorkerManager.MAX_RESTART_ATTEMPTS} tentativas de reinício. Desistindo.`,
      );

      return;
    }

    const delay =
      AIVerificationWorkerManager.BASE_RESTART_DELAY *
      Math.pow(2, attempts - 1);

    console.log(
      `[AIVerificationManager] Tentando reiniciar worker para fila ${queueName} (tentativa ${attempts}/${AIVerificationWorkerManager.MAX_RESTART_ATTEMPTS}) em ${delay / 1000}s...`,
    );

    setTimeout(() => {
      this.startWorker(queueName).catch((err) => {
        console.error(
          `[AIVerificationManager] Falha ao reiniciar worker para fila ${queueName}:`,
          err,
        );
      });
    }, delay);
  }

  public async enqueueVerification(
    queueName: string,
    data: AIVerificationJobData,
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
            new Error(
              `Timeout ao enfileirar verificação para fila ${queueName}`,
            ),
          );
        }
      }, timeout);

      this.pendingResponses.set(messageId, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      worker.postMessage({
        type: "enqueueVerification",
        data,
        id: messageId,
      });
    });
  }

  public async shutdown(): Promise<void> {
    console.log(
      "[AIVerificationManager] Iniciando desligamento dos workers de verificação IA...",
    );

    const shutdownPromises = Array.from(this.workers.entries()).map(
      async ([queueName, worker]) => {
        return new Promise<void>((resolve) => {
          const messageId = uuidv4();
          const timeoutId = setTimeout(() => {
            console.log(
              `[AIVerificationManager] Timeout ao encerrar worker para fila ${queueName}, forçando término...`,
            );

            worker.terminate();
            this.workers.delete(queueName);

            resolve();
          }, 15000);

          this.pendingResponses.set(messageId, {
            resolve: () => {
              clearTimeout(timeoutId);
              this.workers.delete(queueName);

              resolve();
            },
            reject: (err: any) => {
              clearTimeout(timeoutId);
              console.error(
                `[AIVerificationManager] Erro ao encerrar worker para fila ${queueName}:`,
                err,
              );

              worker.terminate();
              this.workers.delete(queueName);

              resolve();
            },
            timeout: timeoutId,
          });

          worker.postMessage({ type: "shutdown", id: messageId });
        });
      },
    );

    await Promise.all(shutdownPromises);
    console.log(
      "[AIVerificationManager] Todos os workers de verificação IA foram encerrados",
    );
  }
}

export default AIVerificationWorkerManager;
