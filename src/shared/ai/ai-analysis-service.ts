import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { sendAIVerificationEvent } from "@/websocket";
import { logger } from "@/shared/logging/logger";
import { getRequestContext } from "@/shared/http/request-context";

import { getOrCreateCurrentPeriod, getQuotaUsage, reserveUnits } from "./ai-quota-service";
import { aiProviderConfigured } from "./ai-provider";
import {
  aiRecordTypeOf,
  buildAnalysisUnits,
  computeIdempotencyKey,
  projectChecklistInput,
} from "./ai-rules";
import { markChecklistSkipped, markFuelSkipped } from "./ai-record-store";
import { AIAnalysisPipelineService } from "./ai-analysis-pipeline-service";
import { AIAnalysisRequestInput } from "./ai-types";
import type { ReadingKind } from "./image-reader";

/**
 * - `not_covered`: every photo is of a kind the configured reader does not
 *   read (ADR 0010 §5: fuel level, tyres, "working" items for OCR). Nothing
 *   is queued and no quota is reserved; the record says "not analysed".
 */
type RequestOutcome =
  | "queued"
  | "denied"
  | "already_running"
  | "already_completed"
  | "unavailable"
  | "not_covered";

/**
 * A revive the quota cannot cover. Thrown to roll its transaction back —
 * the request keeps its terminal status — and answered as "denied".
 */
class ReviveDeniedError extends Error {}

/**
 * A revive with nothing left to read: every unit the reader covers was
 * already read (the rest were given back as not covered). Rolled back and
 * answered "already completed" — reserving zero units read as "denied", and
 * told the user the quota was over.
 */
class NothingToReviveError extends Error {}

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
    received: AIAnalysisRequestInput,
  ): Promise<RequestOutcome> {
    const request = normalizedRequest(received);

    if (buildAnalysisUnits(request.type, request.input).length === 0) {
      return "unavailable";
    }

    // No reader (typically dev, or AI_PROVIDER=none): mark skipped
    // silently, as before.
    if (!aiProviderConfigured()) {
      await this.markRecordSkipped(request);
      return "unavailable";
    }

    // Only the photos the reader answers become units: a checklist of eight
    // photos with one odometer spends one (ADR 0010 §5).
    const units = buildAnalysisUnits(request.type, request.input, readerSupports);

    if (units.length === 0) {
      await this.markRecordSkipped(request);
      return "not_covered";
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
          //
          // The FIRST write is a compare-and-set on the status that was read
          // (IDEMP-09). The `existing` above is a plain read: two revives at
          // once both saw FAILED, both reserved, and the quota stayed
          // reserved twice until the month turned. The row lock this takes
          // makes a concurrent reviver wait, re-check, match nothing and
          // answer "already running". It also moves the request to THIS
          // month's period, where its new reservation is consumed or given
          // back — left on the old one, the new month kept it reserved.
          const revived = await tx.aIAnalysisRequest.updateMany({
            where: { id: existing.id, status: existing.status },
            data: {
              status: "PENDING",
              attempts: 0,
              availableAt: new Date(),
              completedAt: null,
              lastError: null,
              periodId: period.id,
            },
          });

          if (revived.count === 0) return "already_running";

          const existingUnits = await tx.aIAnalysisUnit.findMany({
            where: { requestId: existing.id },
          });

          const consumedKeys = new Set(
            existingUnits
              .filter((unit) => unit.status === "CONSUMED")
              .map((unit) => unit.unitKey),
          );

          const missing = buildAnalysisUnits(
            request.type,
            request.input,
            readerSupports,
          ).filter((unit) => !consumedKeys.has(unit.unitKey));

          if (missing.length === 0) throw new NothingToReviveError();

          const granted = await reserveUnits(
            tx,
            period.id,
            request.businessId,
            missing.length,
          );

          // Rolls the revive back: committed, the request would sit PENDING
          // with nothing reserved, and the pipeline would pay the provider
          // for a call charged to no quota.
          if (granted === 0) throw new ReviveDeniedError();

          const unitsByKey = new Map(
            existingUnits.map((unit) => [unit.unitKey, unit]),
          );

          for (const descriptor of missing.slice(0, granted)) {
            const previous = unitsByKey.get(descriptor.unitKey);

            if (previous) {
              // Never un-consume a unit: its result was billed once.
              await tx.aIAnalysisUnit.updateMany({
                where: { id: previous.id, status: { not: "CONSUMED" } },
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
          readerSupports,
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

        // HTTP request -> AI request: the pipeline's lines carry the AI
        // request id; this one ties it to the x-request-id (contract §32).
        logger.info(
          {
            component: "ai-analysis",
            correlationId: getRequestContext()?.requestId ?? null,
            aiRequestId: created.id,
            type: request.type,
            recordId: request.recordId,
            businessId: request.businessId,
          },
          "ai analysis queued",
        );

        return "queued";
      });
    } catch (error) {
      if (error instanceof ReviveDeniedError) return "denied";
      if (error instanceof NothingToReviveError) return "already_completed";

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
    } else if (request.type === "DELIVERY_PROOF") {
      // Nothing to mark, as in the pipeline's markRecordAnalyzing: a proof
      // has no verdict column, and its card is already in the review queue,
      // where "no suggestion" is the true state. The recordId is a delivery
      // id; sent to the checklist table it threw P2025 and turned every
      // proof without quota into a failed request (INV-08).
      return;
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
      recordType: aiRecordTypeOf(request.type),
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

/** The configured reader's coverage, as the pipeline that will read it sees it. */
function readerSupports(kind: ReadingKind): boolean {
  return AIAnalysisPipelineService.getInstance().supports(kind);
}

/**
 * The input as it is hashed and stored. A checklist carries only its
 * photographed fields and their informed values (projectChecklistInput), so
 * create, update and the manual button hash the same photos the same way
 * (AI-2).
 */
function normalizedRequest(
  request: AIAnalysisRequestInput,
): AIAnalysisRequestInput {
  if (request.type !== "CHECKLIST") return request;

  return { ...request, input: projectChecklistInput(request.input) };
}

export { AIAnalysisService, normalizedRequest, readerSupports };
export type { RequestOutcome };
