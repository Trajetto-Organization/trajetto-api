import database from "@/../infra/database";
import * as amqp from "amqplib";

import {
  RabbitMQConnection,
  AmqpChannel,
} from "infra/messaging/rabbitmq-connection";
import { AIVerificationService } from "@/shared/services/ai-verification-service";

interface AIVerificationJobData {
  type: "fuel_odometer" | "checklist";
  recordId: string;
  businessId: string;
  userId: string;
  // For fuel
  odometerPhotoPath?: string;
  reportedMileage?: number;
  // For checklist
  photosByField?: Record<string, string[]>;
  checklistData?: Record<string, any>;
}

class AIVerificationQueueProvider {
  private channel: AmqpChannel | null = null;
  private queueName: string;

  private prisma = database;

  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  private aiService: AIVerificationService;

  // Callback to emit WebSocket events (set by the worker)
  public onWebSocketEmit: ((userId: string, event: any) => void) | null = null;

  constructor(queueName: string = "aiVerificationQueue") {
    this.queueName = queueName;
    this.aiService = new AIVerificationService();
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

      await this.channel.assertQueue(this.queueName, { durable: true });
      await this.channel.prefetch(2);

      await this.setupConsumer();

      this.isInitialized = true;
      console.log(
        `[AIVerificationQueue] Queue setup complete: ${this.queueName}`,
      );
    } catch (error) {
      console.error(
        `[AIVerificationQueue] Setup failed for queue ${this.queueName}:`,
        error,
      );

      throw error;
    }
  }

  private emitWSEvent(userId: string, event: any) {
    if (this.onWebSocketEmit) {
      this.onWebSocketEmit(userId, event);
    }
  }

  private async setupConsumer() {
    if (!this.channel) throw new Error("Channel not initialized");

    await this.channel.consume(
      this.queueName,
      async (msg) => {
        if (!msg) return;

        try {
          const data = JSON.parse(
            msg.content.toString(),
          ) as AIVerificationJobData;

          await this.processVerification(data);
          this.channel?.ack(msg);
        } catch (error) {
          console.error(
            `[AIVerificationQueue] Error processing message:`,
            error,
          );

          if (this.shouldRetry(msg)) {
            this.channel?.nack(msg, false, false);

            const retryCount = this.getRetryCount(msg);
            // Base delay maior que email (15s) por conta de rate limits da API de IA
            const delay = 15000 * Math.pow(2, retryCount);

            setTimeout(() => {
              this.republishWithRetry(msg, retryCount + 1);
            }, delay);
          } else {
            this.channel?.nack(msg, false, false);
            console.log(
              `[AIVerificationQueue] Message rejected after max retries`,
            );
          }
        }
      },
      { noAck: false },
    );
  }

  private getRetryCount(msg: amqp.ConsumeMessage): number {
    return msg.properties.headers?.["x-retry-count"] || 0;
  }

  private shouldRetry(msg: amqp.ConsumeMessage): boolean {
    return this.getRetryCount(msg) < 3;
  }

  private async republishWithRetry(
    msg: amqp.ConsumeMessage,
    retryCount: number,
  ) {
    try {
      if (!this.channel) await this.initialize();
      if (!this.channel) throw new Error("Failed to initialize channel");

      this.channel.publish("", this.queueName, msg.content, {
        persistent: true,
        headers: { "x-retry-count": retryCount },
      });
    } catch (error) {
      console.error(
        `[AIVerificationQueue] Failed to republish message:`,
        error,
      );
    }
  }

  // Main Processing Logic
  private async processVerification(data: AIVerificationJobData) {
    // Check if AI service is available
    if (!this.aiService.isAvailable()) {
      console.log(
        "[AIVerificationQueue] AI service not available, skipping verification",
      );

      await this.markAsSkipped(data);
      return;
    }

    // Check business limit
    const limit = await this.aiService.checkBusinessLimit(data.businessId);
    if (!limit.allowed) {
      console.log(
        `[AIVerificationQueue] Business ${data.businessId} exceeded AI analysis limit (${limit.used}/${limit.limit})`,
      );

      await this.markAsSkipped(data);
      this.emitWSEvent(data.userId, {
        recordType: data.type === "fuel_odometer" ? "fuel" : "checklist",
        recordId: data.recordId,
        businessId: data.businessId,
        step: "skipped",
        stepNumber: 1,
        totalSteps: 1,
        overallStatus: "skipped",
        message: `Limite de análises atingido (${limit.used}/${limit.limit})`,
        usage: {
          used: limit.used,
          limit: limit.limit,
          remaining: limit.remaining,
          resetAt: null,
        },
        timestamp: new Date().toISOString(),
      });

      return;
    }

    if (data.type === "fuel_odometer") {
      await this.processFuelOdometer(data);
    } else if (data.type === "checklist") {
      await this.processChecklist(data);
    }
  }

  // Fuel Odometer Processing
  private async processFuelOdometer(data: AIVerificationJobData) {
    const { recordId, userId, odometerPhotoPath, reportedMileage } = data;

    if (!odometerPhotoPath || reportedMileage === undefined) {
      console.error("[AIVerificationQueue] Missing fuel data for verification");
      return;
    }

    const totalSteps = 4;

    // Step 1: Queued
    this.emitWSEvent(userId, {
      recordType: "fuel",
      recordId,
      step: "queued",
      stepNumber: 1,
      totalSteps,
      timestamp: new Date().toISOString(),
    });

    // Update status to analyzing
    await this.prisma.fuel.update({
      where: { id: recordId },
      data: { odometer_ai_status: "analyzing" },
    });

    // Step 2: Analyzing
    this.emitWSEvent(userId, {
      recordType: "fuel",
      recordId,
      step: "analyzing",
      stepNumber: 2,
      totalSteps,
      timestamp: new Date().toISOString(),
    });

    // Call AI
    const result = await this.aiService.analyzeOdometerImage(
      odometerPhotoPath,
      reportedMileage,
    );

    // Step 3: Reading completed
    this.emitWSEvent(userId, {
      recordType: "fuel",
      recordId,
      step: "reading_odometer",
      stepNumber: 3,
      totalSteps,
      currentResult: {
        status: result.status,
        details: result.details,
        confidence: result.confidence,
        aiReadValue: result.readMileage,
        reportedValue: reportedMileage,
      },
      timestamp: new Date().toISOString(),
    });

    // Update database
    await this.prisma.fuel.update({
      where: { id: recordId },
      data: {
        odometer_ai_reading: result.readMileage,
        odometer_ai_status: result.status,
        odometer_ai_details: result.rawResponse,
        odometer_ai_analyzed_at: new Date(),
        odometer_verified: result.status === "verified",
      },
    });

    // Increment usage only if AI actually processed (not on error)
    if (result.status !== "error") {
      await this.aiService.incrementBusinessUsage(data.businessId);
    }

    // Fetch updated usage to include in the event
    const fuelUsage = await this.getBusinessUsage(data.businessId);

    // Step 4: Completed
    this.emitWSEvent(userId, {
      recordType: "fuel",
      recordId,
      businessId: data.businessId,
      step: "completed",
      stepNumber: 4,
      totalSteps,
      overallStatus: result.status,
      currentResult: {
        status: result.status,
        details: result.details,
        confidence: result.confidence,
        aiReadValue: result.readMileage,
        reportedValue: reportedMileage,
      },
      usage: fuelUsage,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[AIVerificationQueue] Fuel ${recordId} verification completed: ${result.status}`,
    );
  }

  // Checklist Processing
  private async processChecklist(data: AIVerificationJobData) {
    const { recordId, userId, photosByField, checklistData } = data;

    if (!photosByField || !checklistData) {
      console.error(
        "[AIVerificationQueue] Missing checklist data for verification",
      );

      return;
    }

    const fieldsToAnalyze = Object.keys(photosByField);
    const totalSteps = fieldsToAnalyze.length + 2; // queued + fields + completed

    // Step 1: Queued
    this.emitWSEvent(userId, {
      recordType: "checklist",
      recordId,
      step: "queued",
      stepNumber: 1,
      totalSteps,
      timestamp: new Date().toISOString(),
    });

    // Update status to analyzing
    await this.prisma.vehicleChecklist.update({
      where: { id: recordId },
      data: { ai_verification_status: "analyzing" },
    });

    // Analyze each field
    const allResults: Record<string, any> = {};

    let hasContradiction = false;
    let stepNumber = 2;

    for (const fieldName of fieldsToAnalyze) {
      const photoPaths = photosByField[fieldName];
      const fieldValue = checklistData[fieldName];

      this.emitWSEvent(userId, {
        recordType: "checklist",
        recordId,
        step: "analyzing_field",
        stepNumber,
        totalSteps,
        fieldName,
        timestamp: new Date().toISOString(),
      });

      // Analyze first photo of each field (primary photo)
      const primaryPhoto = photoPaths[0];
      if (primaryPhoto) {
        const result = await this.aiService.analyzeChecklistImage(
          primaryPhoto,
          fieldName,
          fieldValue,
        );

        allResults[fieldName] = {
          status: result.status,
          confidence: result.confidence,
          observation: result.observation,
          rawResponse: result.rawResponse,
          photosAnalyzed: 1,
        };

        if (result.status === "contradicts") {
          hasContradiction = true;
        }
      }

      stepNumber++;
    }

    // Count only successfully analyzed fields (not inconclusive due to errors)
    const successfulAnalyses = Object.values(allResults).filter(
      (r) => r.status !== "inconclusive" || r.confidence > 0,
    ).length;

    // Merge with existing AI verification details (preserve previous field results)
    const existingChecklist = await this.prisma.vehicleChecklist.findUnique({
      where: { id: recordId },
      select: { ai_verification_details: true },
    });

    let existingDetails: Record<string, any> = {};
    if (existingChecklist?.ai_verification_details) {
      existingDetails =
        typeof existingChecklist.ai_verification_details === "string"
          ? JSON.parse(existingChecklist.ai_verification_details)
          : (existingChecklist.ai_verification_details as Record<string, any>);
    }

    // New results take priority per field, previous fields are preserved
    const mergedResults = { ...existingDetails, ...allResults };

    // Recalculate overall status based on ALL merged results
    const mergedHasContradiction = Object.values(mergedResults).some(
      (r: any) => r.status === "contradicts",
    );
    const mergedSuccessfulAnalyses = Object.values(mergedResults).filter(
      (r: any) => r.status !== "inconclusive" || r.confidence > 0,
    ).length;

    const overallStatus =
      mergedSuccessfulAnalyses === 0
        ? "error"
        : mergedHasContradiction
          ? "issues_found"
          : "verified";

    // Update database with merged results
    await this.prisma.vehicleChecklist.update({
      where: { id: recordId },
      data: {
        ai_verification_status: overallStatus,
        ai_verification_details: mergedResults,
        ai_verified_at: new Date(),
      },
    });

    // Increment usage only for fields that were actually analyzed
    if (successfulAnalyses > 0) {
      await this.aiService.incrementBusinessUsage(
        data.businessId,
        successfulAnalyses,
      );
    }

    // Fetch updated usage to include in the event
    const checklistUsage = await this.getBusinessUsage(data.businessId);

    // Final step: Completed
    this.emitWSEvent(userId, {
      recordType: "checklist",
      recordId,
      businessId: data.businessId,
      step: "completed",
      stepNumber: totalSteps,
      totalSteps,
      overallStatus,
      currentResult: {
        status: overallStatus,
        details:
          overallStatus === "error"
            ? "Não foi possível realizar a verificação IA. Tente novamente mais tarde."
            : hasContradiction
              ? "Algumas condições informadas não correspondem às fotos"
              : "Todas as condições verificadas com sucesso",
        fieldsAnalyzed: Object.keys(mergedResults).length,
        fieldResults: mergedResults,
      },
      usage: checklistUsage,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[AIVerificationQueue] Checklist ${recordId} verification completed: ${overallStatus}`,
    );
  }

  // Fetch current usage for the business (included in WS events)
  private async getBusinessUsage(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        ai_analysis_limit: true,
        ai_analysis_used: true,
        ai_analysis_reset_at: true,
      },
    });

    if (!business) return null;

    return {
      used: business.ai_analysis_used,
      limit: business.ai_analysis_limit,
      remaining: Math.max(
        0,
        business.ai_analysis_limit - business.ai_analysis_used,
      ),
      resetAt: business.ai_analysis_reset_at?.toISOString() || null,
    };
  }

  // Helpers
  private async markAsSkipped(data: AIVerificationJobData) {
    if (data.type === "fuel_odometer") {
      await this.prisma.fuel.update({
        where: { id: data.recordId },
        data: {
          odometer_ai_status: "skipped",
          odometer_ai_analyzed_at: new Date(),
        },
      });
    } else {
      await this.prisma.vehicleChecklist.update({
        where: { id: data.recordId },
        data: {
          ai_verification_status: "skipped",
          ai_verified_at: new Date(),
        },
      });
    }
  }

  // Enqueue
  public async enqueueVerification(
    jobData: AIVerificationJobData,
  ): Promise<void> {
    if (!this.isInitialized) await this.initialize();
    if (!this.channel) throw new Error("Channel not available");

    const success = this.channel.sendToQueue(
      this.queueName,
      Buffer.from(JSON.stringify(jobData)),
      {
        persistent: true,
        headers: { "x-retry-count": 0 },
      },
    );

    if (!success) throw new Error("Failed to enqueue AI verification job");
    console.log(
      `[AIVerificationQueue] Enqueued ${jobData.type} verification for record ${jobData.recordId}`,
    );
  }

  public async close(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();

        this.channel = null;
        this.isInitialized = false;

        console.log(`[AIVerificationQueue] Channel fechado: ${this.queueName}`);
      }
    } catch (error) {
      console.error(`[AIVerificationQueue] Erro ao fechar channel:`, error);
    }
  }
}

export { AIVerificationQueueProvider, AIVerificationJobData };
