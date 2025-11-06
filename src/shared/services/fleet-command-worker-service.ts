import { FleetCommandWorkerManager } from "@/workers/fleet-command-worker-manage";
import { FleetCommandJobData } from "@/jobs/fleet-command-queue";

class FleetCommandWorkerService {
  private static instance: FleetCommandWorkerService;
  private workerManager: FleetCommandWorkerManager;

  private queueName = "fleetCommandQueue";

  private constructor() {
    const environment = (process.env.NODE_ENV || "development") as
      | "development"
      | "production"
      | "test";
    this.workerManager = FleetCommandWorkerManager.getInstance(environment);
  }

  public static getInstance(): FleetCommandWorkerService {
    if (!FleetCommandWorkerService.instance) {
      FleetCommandWorkerService.instance = new FleetCommandWorkerService();
    }
    return FleetCommandWorkerService.instance;
  }

  public async initialize(): Promise<void> {
    console.log(
      "[FleetCommandWorkerService] Initializing Fleet Command worker...",
    );

    await this.workerManager.startWorker(this.queueName);
    console.log("[FleetCommandWorkerService] Fleet Command worker initialized");
  }

  public async enqueueJob(jobData: FleetCommandJobData): Promise<void> {
    try {
      await this.workerManager.enqueueJob(this.queueName, jobData);
      console.log(
        `[FleetCommandWorkerService] Job ${jobData.jobType} enqueued successfully`,
      );
    } catch (error) {
      console.error("[FleetCommandWorkerService] Error enqueueing job:", error);
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
    console.log("[FleetCommandWorkerService] Fleet Command worker shut down");
  }
}

export default FleetCommandWorkerService;
