import { Worker } from "node:worker_threads";
import path from "node:path";

import { FleetCommandWorkerData } from "./types";
import { env } from "../env";

interface PendingResponse {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}

class FleetCommandWorkerManager {
  private static instance: FleetCommandWorkerManager;
  private workers: Map<string, Worker> = new Map();

  private pendingResponses: Map<string, PendingResponse> = new Map();
  private messageIdCounter = 0;

  constructor(private environment: FleetCommandWorkerData["environment"]) {
    process.on("SIGINT", this.shutdown.bind(this));
    process.on("SIGTERM", this.shutdown.bind(this));
  }

  public static getInstance(
    environment: FleetCommandWorkerData["environment"] = "development",
  ): FleetCommandWorkerManager {
    if (!FleetCommandWorkerManager.instance) {
      FleetCommandWorkerManager.instance = new FleetCommandWorkerManager(
        environment,
      );
    }
    return FleetCommandWorkerManager.instance;
  }

  public async startWorker(queueName: string): Promise<void> {
    if (this.workers.has(queueName)) {
      console.log(
        `[FleetCommandWorkerManager] Worker already exists: ${queueName}`,
      );
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const workerPath =
          env.NODE_ENV === "production"
            ? path.resolve(
                process.cwd(),
                "build",
                "workers",
                "fleet-command-worker.js",
              )
            : path.resolve(
                process.cwd(),
                "src",
                "workers",
                "fleet-command-worker.ts",
              );

        console.log(
          `[FleetCommandWorkerManager] Starting worker with path: ${workerPath}`,
        );

        const workerData: FleetCommandWorkerData = {
          queueName,
          environment: this.environment,
        };

        const workerOptions = {
          workerData,
          ...(env.NODE_ENV !== "production" && { execArgv: ["-r", "tsx"] }),
        };

        const worker = new Worker(workerPath, workerOptions);

        worker.on("message", (message) => {
          if (message.type === "ready") {
            this.workers.set(queueName, worker);
            console.log(
              `[FleetCommandWorkerManager] Worker ready: ${queueName}`,
            );
            resolve();
          } else if (message.id) {
            const pending = this.pendingResponses.get(message.id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingResponses.delete(message.id);

              if (message.type === "error") {
                pending.reject(new Error(message.error));
              } else {
                pending.resolve(message);
              }
            }
          }
        });

        worker.on("error", (error) => {
          console.error(
            `[FleetCommandWorkerManager] Worker error for ${queueName}:`,
            error,
          );
          this.workers.delete(queueName);
          reject(error);
          this.restartWorker(queueName);
        });

        worker.on("exit", (code) => {
          if (code !== 0) {
            console.error(
              `[FleetCommandWorkerManager] Worker ${queueName} exited with code ${code}`,
            );
            this.workers.delete(queueName);
            this.restartWorker(queueName);
          }
        });
      } catch (error) {
        console.error(
          `[FleetCommandWorkerManager] Error starting worker:`,
          error,
        );
        reject(error);
      }
    });
  }

  private async restartWorker(queueName: string): Promise<void> {
    console.log(`[FleetCommandWorkerManager] Restarting worker: ${queueName}`);

    setTimeout(() => {
      this.startWorker(queueName).catch((error) => {
        console.error(
          `[FleetCommandWorkerManager] Error restarting worker:`,
          error,
        );
      });
    }, 5000);
  }

  public async enqueueJob(queueName: string, data: any): Promise<void> {
    const worker = this.workers.get(queueName);

    if (!worker) {
      throw new Error(`Worker not found for queue: ${queueName}`);
    }

    return new Promise((resolve, reject) => {
      const messageId = `${Date.now()}-${this.messageIdCounter++}`;
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(messageId);
        reject(new Error("Worker response timeout"));
      }, 30000);

      this.pendingResponses.set(messageId, { resolve, reject, timeout });

      worker.postMessage({
        type: "enqueueJob",
        data,
        id: messageId,
      });
    });
  }

  public async shutdown(): Promise<void> {
    const shutdownPromises = Array.from(this.workers.entries()).map(
      ([queueName, worker]) =>
        new Promise<void>((resolve) => {
          const messageId = `shutdown-${Date.now()}`;
          worker.postMessage({ type: "shutdown", id: messageId });

          const timeout = setTimeout(() => {
            worker.terminate();
            resolve();
          }, 5000);

          worker.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
    );

    await Promise.all(shutdownPromises);
    this.workers.clear();

    console.log("[FleetCommandWorkerManager] All workers shut down");
  }
}

export { FleetCommandWorkerManager };
