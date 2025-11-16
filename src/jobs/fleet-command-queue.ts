import * as amqp from "amqplib";
import {
  RabbitMQConnection,
  AmqpChannel,
} from "infra/messaging/rabbitmq-connection";

import { SimulationProcessor } from "./processors/simulation-processor";
import { AnalyticsProcessor } from "./processors/analytics-processor";

interface FleetCommandJobData {
  jobType: "simulation" | "heatmap" | "analytics";
  businessId: string;
  userId?: string;
  data: any;
}

class FleetCommandQueueProvider {
  private channel: AmqpChannel | null = null;
  private queueName: string;

  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  // Processors
  private simulationProcessor: SimulationProcessor;
  private analyticsProcessor: AnalyticsProcessor;

  constructor(queueName: string = "fleetCommandQueue") {
    this.queueName = queueName;
    this.simulationProcessor = new SimulationProcessor();
    this.analyticsProcessor = new AnalyticsProcessor();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.setup();
    return this.initPromise;
  }

  private async setup(): Promise<void> {
    try {
      const rabbitmqConnection = RabbitMQConnection.getInstance();
      this.channel = await rabbitmqConnection.createChannel(this.queueName);

      await this.channel.assertQueue(this.queueName, {
        durable: true,
      });

      await this.channel.prefetch(2); // Process 2 heavy jobs at a time
      await this.setupConsumer();

      this.isInitialized = true;
      console.log(
        `[FleetCommandQueue] Queue setup complete: ${this.queueName}`,
      );
    } catch (error) {
      console.error(
        `[FleetCommandQueue] Setup failed for queue ${this.queueName}:`,
        error,
      );
      throw error;
    }
  }

  private async setupConsumer() {
    if (!this.channel) throw new Error("Channel not initialized");

    await this.channel.consume(
      this.queueName,
      async (msg) => {
        if (!msg) return;

        try {
          const jobData = JSON.parse(
            msg.content.toString(),
          ) as FleetCommandJobData;
          await this.processJob(jobData);

          this.channel?.ack(msg);
        } catch (error) {
          console.error(`[FleetCommandQueue] Error processing job:`, error);

          if (this.shouldRetry(msg)) {
            this.channel?.nack(msg, false, false);

            const retryCount = this.getRetryCount(msg);
            const delay = 15000 * Math.pow(2, retryCount); // 15s, 30s, 60s

            setTimeout(() => {
              this.republishWithRetry(msg, retryCount + 1);
            }, delay);
          } else {
            this.channel?.nack(msg, false, false);
            console.log(`[FleetCommandQueue] Job rejected after max retries`);
          }
        }
      },
      { noAck: false },
    );
  }

  private getRetryCount(msg: amqp.ConsumeMessage): number {
    const headers = msg.properties.headers || {};
    return headers["x-retry-count"] || 0;
  }

  private shouldRetry(msg: amqp.ConsumeMessage): boolean {
    const retryCount = this.getRetryCount(msg);
    return retryCount < 2; // Max 2 retries for heavy jobs
  }

  private async republishWithRetry(
    msg: amqp.ConsumeMessage,
    retryCount: number,
  ) {
    try {
      if (!this.channel) {
        await this.initialize();
      }

      if (!this.channel) {
        throw new Error("Failed to initialize channel for retry");
      }

      this.channel.publish("", this.queueName, msg.content, {
        persistent: true,
        headers: {
          "x-retry-count": retryCount,
        },
      });
    } catch (error) {
      console.error(`[FleetCommandQueue] Failed to republish job:`, error);
    }
  }

  private async processJob(jobData: FleetCommandJobData) {
    console.log(
      `[FleetCommandQueue] Processing ${jobData.jobType} job for business ${jobData.businessId}`,
    );

    try {
      switch (jobData.jobType) {
        case "simulation":
          await this.simulationProcessor.process(jobData);
          break;
        case "heatmap":
          // To be implemented in next phase
          console.log(
            "[FleetCommandQueue] Heatmap processor not implemented yet",
          );
          break;
        case "analytics":
          await this.analyticsProcessor.process(jobData);
          break;
        default:
          throw new Error(`Unknown job type: ${jobData.jobType}`);
      }

      console.log(`[FleetCommandQueue] Job completed: ${jobData.jobType}`);
    } catch (error) {
      console.error(`[FleetCommandQueue] Error in job processor:`, error);
      throw error;
    }
  }

  public async enqueueJob(jobData: FleetCommandJobData): Promise<void> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (!this.channel) {
        throw new Error("Channel not available");
      }

      const success = this.channel.sendToQueue(
        this.queueName,
        Buffer.from(JSON.stringify(jobData)),
        {
          persistent: true,
          headers: {
            "x-retry-count": 0,
          },
        },
      );

      if (!success) {
        throw new Error("Failed to enqueue Fleet Command job");
      }

      console.log(
        `[FleetCommandQueue] Successfully enqueued ${jobData.jobType} job`,
      );
    } catch (error) {
      console.error("[FleetCommandQueue] Error enqueueing job:", error);
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.channel) {
      await this.channel.close();

      this.channel = null;
      this.isInitialized = false;

      console.log(
        `[FleetCommandQueue] Channel closed for queue: ${this.queueName}`,
      );
    }
  }
}

export { FleetCommandQueueProvider, FleetCommandJobData };
