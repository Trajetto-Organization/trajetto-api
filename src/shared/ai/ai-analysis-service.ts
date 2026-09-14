import database from "@/../infra/database";
import { env } from "@/env";
import { Prisma } from "@prisma/client";

import { sendAIVerificationEvent } from "@/websocket";

import { getOrCreateCurrentPeriod, getQuotaUsage, reserveUnits } from "./ai-quota-service";
import { buildAnalysisUnits, computeIdempotencyKey } from "./ai-rules";
import { markChecklistSkipped, markFuelSkipped } from "./ai-record-store";
import { AIAnalysisPipelineService } from "./ai-analysis-pipeline-service";
import { AIAnalysisRequestInput } from "./ai-types";

type RequestOutcome =
  | "queued"
  | "denied"
  | "already_running"
  | "already_completed"
  | "unavailable";

/**
 * Entry point the usecases call after their record commits. Creates the
 * durable AIAnalysisRequest, reserves quota and wakes the pipeline — or, when
 * the quota is exhausted, marks the record as skipped exactly like the legacy
 * consumer did, so the frontends see the same thing they always saw.
 *
 * Creation is idempotent by (type, record, input-hash): usecase retries and
 * mobile outbox replays reuse the existing request instead of double-charging.
 * A request that was denied by quota gets revived by the same key when quota
 * exists again (limit raised, new month) and the input is resubmitted.
 */
class AIAnalysisService {
  private static instance: AIAnalysisService;

  private constructor() {}

  public static getInstance(): AIAnalysisService {
    if (!AIAnalysisService.instance) {
      AIAnalysisService.instance = new AIAnalysisService();
    }

    return AIAnalysisService.instance;
  }

  public async requestAnalysis(
    request: AIAnalysisRequestInput,
  ): Promise<RequestOutcome> {
    const units = buildAnalysisUnits(request.type, request.input);
    if (units.length === 0) return "unavailable";

    // No API key (typically dev): mark skipped silently, as before.
    if (!env.ANTHROPIC_API_KEY) {
      await this.markRecordSkipped(request);
      return "unavailable";
    }

    const idempotencyKey = computeIdempotencyKey(
      request.type,
      request.recordId,
      request.input,
    );

    const outcome = await this.createRequest(request, idempotencyKey, units.length);

    if (outcome === "queued") {
      AIAnalysisPipelineService.getInstance().wake();
    }

    if (outcome === "denied") {
      await this.markRecordSkipped(request);
      await this.emitSkippedEvent(request);
    }

    return outcome;
  }

  private async createRequest(
    request: AIAnalysisRequestInput,
    idempotencyKey: string,
    requestedUnits: number,
  ): Promise<RequestOutcome> {
    try {
      return await database.$transaction(async (tx) => {
        const existing = await tx.aIAnalysisRequest.findUnique({
          where: { idempotencyKey },
        });

        // Same input, job still in flight or already done: nothing to redo.
        if (existing) {
          if (existing.status === "PENDING" || existing.status === "PROCESSING") {
            return "already_running";
          }

          if (existing.status === "COMPLETED") return "already_completed";
        }

        const period = await getOrCreateCurrentPeriod(tx, request.businessId);

        if (existing) {
          // Revive a terminal request (SKIPPED by quota, FAILED, PARTIAL):
          // the "verificar novamente" path. Units already CONSUMED keep
          // their results and are not re-billed — only the missing ones need
          // fresh quota.
          const existingUnits = await tx.aIAnalysisUnit.findMany({
            where: { requestId: existing.id },
          });

          const consumedKeys = new Set(
            existingUnits
              .filter((unit) => unit.status === "CONSUMED")
              .map((unit) => unit.unitKey),
          );

          const missing = buildAnalysisUnits(request.type, request.input).filter(
            (unit) => !consumedKeys.has(unit.unitKey),
          );

          const granted = await reserveUnits(
            tx,
            period.id,
            request.businessId,
            missing.length,
          );

          if (granted === 0) return "denied";

          const unitsByKey = new Map(
            existingUnits.map((unit) => [unit.unitKey, unit]),
          );

          for (const descriptor of missing.slice(0, granted)) {
            const previous = unitsByKey.get(descriptor.unitKey);

            if (previous) {
              await tx.aIAnalysisUnit.update({
                where: { id: previous.id },
                data: {
                  status: "RESERVED",
                  releasedAt: null,
                  lastError: null,
                },
              });
            } else {
              await tx.aIAnalysisUnit.create({
                data: { requestId: existing.id, unitKey: descriptor.unitKey },
              });
            }
          }

          await tx.aIAnalysisRequest.update({
            where: { id: existing.id },
            data: {
              status: "PENDING",
              attempts: 0,
              availableAt: new Date(),
              completedAt: null,
              lastError: null,
            },
          });

          return "queued";
        }

        const granted = await reserveUnits(
          tx,
          period.id,
          request.businessId,
          requestedUnits,
        );

        // A partial grant still runs: the unit builder ordered the fields so
        // the highest-value ones (odometer first) get the remaining quota.
        const grantedUnits = buildAnalysisUnits(
          request.type,
          request.input,
        ).slice(0, granted);

        if (granted === 0) {
          // The denial is recorded: "why wasn't this analyzed" has an answer.
          await tx.aIAnalysisRequest.create({
            data: {
              idempotencyKey,
              type: request.type,
              recordId: request.recordId,
              businessId: request.businessId,
              periodId: period.id,
              requestedById: request.requestedById,
              input: request.input as unknown as Prisma.InputJsonValue,
              status: "SKIPPED",
              completedAt: new Date(),
              lastError: "Limite de análises do período atingido",
            },
          });

          return "denied";
        }

        const created = await tx.aIAnalysisRequest.create({
          data: {
            idempotencyKey,
            type: request.type,
            recordId: request.recordId,
            businessId: request.businessId,
            periodId: period.id,
            requestedById: request.requestedById,
            input: request.input as unknown as Prisma.InputJsonValue,
          },
        });

        await tx.aIAnalysisUnit.createMany({
          data: grantedUnits.map((unit) => ({
            requestId: created.id,
            unitKey: unit.unitKey,
          })),
        });

        return "queued";
      });
    } catch (error) {
      // Two concurrent calls raced past the findUnique: the loser's insert
      // hits the idempotency key — the job exists, nothing to do.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return "already_running";
      }

      throw error;
    }
  }

  private async markRecordSkipped(
    request: AIAnalysisRequestInput,
  ): Promise<void> {
    if (request.type === "FUEL_ODOMETER") {
      await markFuelSkipped(request.recordId);
    } else {
      await markChecklistSkipped(request.recordId);
    }
  }

  private async emitSkippedEvent(
    request: AIAnalysisRequestInput,
  ): Promise<void> {
    const usage = await getQuotaUsage(request.businessId);
    const committed = usage ? usage.consumed + usage.inProgress : null;

    sendAIVerificationEvent(request.requestedById, {
      recordType: request.type === "FUEL_ODOMETER" ? "fuel" : "checklist",
      recordId: request.recordId,
      businessId: request.businessId,
      step: "skipped",
      stepNumber: 1,
      totalSteps: 1,
      overallStatus: "skipped",
      message:
        usage && committed !== null
          ? `Limite de análises atingido (${committed}/${usage.limit})`
          : "Limite de análises atingido",
      usage: usage
        ? {
            used: usage.consumed,
            inProgress: usage.inProgress,
            limit: usage.limit,
            remaining: usage.remaining,
            resetAt: usage.resetAt.toISOString(),
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  }
}

export { AIAnalysisService };
