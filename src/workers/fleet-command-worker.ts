import { parentPort, workerData } from "node:worker_threads";

import { FleetCommandQueueProvider } from "../jobs/fleet-command-queue";
import { FleetCommandWorkerData } from "./types";

interface FleetCommandQueueWithClose extends FleetCommandQueueProvider {
  close(): Promise<void>;
}

const { queueName } = workerData as FleetCommandWorkerData;

let fleetCommandQueue: FleetCommandQueueWithClose;

try {
  console.log(`[FleetCommandWorker] Starting worker for queue: ${queueName}`);

  fleetCommandQueue = new FleetCommandQueueProvider(
    queueName,
  ) as FleetCommandQueueWithClose;

  fleetCommandQueue
    .initialize()
    .then(() => {
      parentPort?.postMessage({ type: "ready", queueName });
    })
    .catch((error) => {
      console.error(`[FleetCommandWorker] Error initializing queue:`, error);
      parentPort?.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    });
} catch (error) {
  console.error(`[FleetCommandWorker] Error initializing worker:`, error);
  parentPort?.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : "Unknown error",
  });
}

parentPort?.on("message", async (message) => {
  try {
    const { type, data, id } = message;

    switch (type) {
      case "enqueueJob": {
        console.log(
          `[FleetCommandWorker] Processing job for queue: ${queueName}`,
        );
        try {
          await fleetCommandQueue.enqueueJob(data);
          parentPort?.postMessage({ type: "success", id });
        } catch (jobError) {
          console.error(`[FleetCommandWorker] Error processing job:`, jobError);
          parentPort?.postMessage({
            type: "error",
            error:
              jobError instanceof Error ? jobError.message : "Unknown error",
            id,
          });
        }
        break;
      }

      case "shutdown": {
        console.log(`[FleetCommandWorker] Shutting down worker: ${queueName}`);
        try {
          if (fleetCommandQueue.close) {
            await fleetCommandQueue.close();
          }
          parentPort?.postMessage({ type: "closed", id });
        } catch (shutdownError) {
          console.error(
            `[FleetCommandWorker] Error shutting down:`,
            shutdownError,
          );
          parentPort?.postMessage({
            type: "error",
            error:
              shutdownError instanceof Error
                ? shutdownError.message
                : "Unknown error",
            id,
          });
        }
        process.exit(0);
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error(`[FleetCommandWorker] Error processing message:`, error);
    parentPort?.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error",
      id: message.id,
    });
  }
});

process.on("uncaughtException", (error) => {
  console.error("[FleetCommandWorker] Uncaught exception:", error);
  parentPort?.postMessage({
    type: "error",
    error: `Uncaught exception: ${error.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[FleetCommandWorker] Unhandled rejection:", reason);
  parentPort?.postMessage({
    type: "error",
    error: `Unhandled rejection: ${reason}`,
  });
});
