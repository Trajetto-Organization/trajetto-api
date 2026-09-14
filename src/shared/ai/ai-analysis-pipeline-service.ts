import database from "@/../infra/database";
import { AIAnalysisType, AIAnalysisUnit, Prisma } from "@prisma/client";

import { sendAIVerificationEvent } from "@/websocket";

import { nextRetryDelayMs } from "@/shared/notifications/pipeline-rules";
import { OutboxService } from "@/shared/notifications/outbox-service";

import {
  AIAnalysisProvider,
  PROVIDER_NAME,
  VISION_MODEL,
  providerErrorStatus,
} from "./ai-provider";
import { consumeReservedUnit, getQuotaUsage, releaseReservedUnits } from "./ai-quota-service";
import {
  ChecklistFieldOutcome,
  buildAnalysisUnits,
  evaluateChecklistField,
  evaluateOdometerReading,
  isNonRetryableProviderStatus,
  mergeChecklistResults,
} from "./ai-rules";
import {
  markChecklistAnalyzing,
  markFuelAnalyzing,
  markFuelError,
  readChecklistExistingDetails,
  writeChecklistResults,
  writeFuelResult,
} from "./ai-record-store";
import {
  AIAnalysisInputMap,
  AnalysisUnitDescriptor,
  ChecklistUnitResult,
  OdometerUnitResult,
  ProviderCallUsage,
} from "./ai-types";

/**
 * Same wake-driven shape as the notification pipeline: `requestAnalysis`
 * wakes processing right after commit, and the interval is only a background
 * sweep for retries, leases orphaned by a dead replica and requests created
 * by other replicas.
 */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Vision calls take seconds each and a checklist can hold a dozen units, so
 * the lease is generous. A replica dying mid-request only delays the retry
 * by this window — consumed units keep their results and are not re-billed.
 */
const CLAIM_LEASE_SECONDS = 300;

/** Mirrors the old RabbitMQ prefetch: at most 2 requests in flight per replica. */
const REQUEST_BATCH_SIZE = 2;

/** Backoff between attempts; length + 1 also caps the attempts. */
const AI_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

interface ClaimedRequest {
  id: string;
  type: AIAnalysisType;
  recordId: string;
  businessId: string;
  periodId: string;
  requestedById: string;
  input: unknown;
  attempts: number;
}

/** A failure retrying can never fix (record deleted, malformed input). */
class NonRetryableRequestError extends Error {}

/**
 * A provider call that will fail identically on every retry (invalid API
 * key, forbidden, malformed request). Surfaces the error to the user in
 * seconds instead of after the whole backoff schedule.
 */
class NonRetryableUnitError extends Error {}

/**
 * Consumes AIAnalysisRequest rows: claims with `FOR UPDATE SKIP LOCKED` +
 * lease, calls the vision model per unit, persists the attempt trail and the
 * per-unit results, settles the quota ledger and writes the verdict back to
 * the Fuel/VehicleChecklist record — emitting the same `aiVerification`
 * websocket steps the frontends already understand.
 */
class AIAnalysisPipelineService {
  private static instance: AIAnalysisPipelineService;

  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;

  private provider = new AIAnalysisProvider();
  private outbox = new OutboxService();

  private constructor() {}

  public static getInstance(): AIAnalysisPipelineService {
    if (!AIAnalysisPipelineService.instance) {
      AIAnalysisPipelineService.instance = new AIAnalysisPipelineService();
    }

    return AIAnalysisPipelineService.instance;
  }

  public async initialize(): Promise<void> {
    this.sweepTimer = setInterval(() => {
      this.runCycle().catch((error) => {
        console.error("[AIAnalysisPipeline] Cycle error:", error);
      });
    }, SWEEP_INTERVAL_MS);

    // Drain whatever accumulated while the API was down.
    this.wake();

    console.log("[AIAnalysisPipeline] Pipeline de análises IA iniciado");
  }

  /** Processes pending requests now instead of waiting for the sweep. */
  public wake(): void {
    this.runCycle().catch((error) => {
      console.error("[AIAnalysisPipeline] Wake error:", error);
    });
  }

  public async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    // Let an in-flight request finish; the lease covers anything interrupted.
    const deadline = Date.now() + 10_000;

    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[AIAnalysisPipeline] Pipeline de análises IA encerrado");
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // Drain: a full batch means there is probably more behind it.
      for (;;) {
        const requests = await this.claimRequests();

        for (const request of requests) {
          try {
            await this.processRequest(request);
          } catch (error) {
            await this.recordRequestFailure(request, error);
          }
        }

        if (requests.length < REQUEST_BATCH_SIZE) break;
      }
    } finally {
      this.running = false;
    }
  }

  private async claimRequests(): Promise<ClaimedRequest[]> {
    return database.$queryRaw<ClaimedRequest[]>`
      UPDATE "ai_analysis_request" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "ai_analysis_request"
        WHERE ("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now())
        ORDER BY "created_at"
        LIMIT ${REQUEST_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "type", "recordId", "businessId", "periodId",
                "requestedById", "input", "attempts"
    `;
  }

  // ==========================================================================
  // Request processing
  // ==========================================================================

  private async processRequest(request: ClaimedRequest): Promise<void> {
    const descriptors = buildAnalysisUnits(
      request.type,
      request.input as AIAnalysisInputMap[typeof request.type],
    );

    const descriptorByKey = new Map(
      descriptors.map((descriptor) => [descriptor.unitKey, descriptor]),
    );

    const units = await database.aIAnalysisUnit.findMany({
      where: { requestId: request.id },
      orderBy: { created_at: "asc" },
    });

    if (request.type === "FUEL_ODOMETER") {
      await this.processFuelRequest(request, units, descriptorByKey);
    } else {
      await this.processChecklistRequest(request, units, descriptorByKey);
    }
  }

  private async processFuelRequest(
    request: ClaimedRequest,
    units: AIAnalysisUnit[],
    descriptorByKey: Map<string, AnalysisUnitDescriptor>,
  ): Promise<void> {
    const input = request.input as AIAnalysisInputMap["FUEL_ODOMETER"];
    const totalSteps = 4;

    // Only the first attempt announces itself — a retry re-firing "queued"
    // would re-toast "verificação iniciada" at the user mid-analysis.
    if (request.attempts === 1) {
      this.emit(request, {
        step: "queued",
        stepNumber: 1,
        totalSteps,
      });
    }

    await this.markRecordAnalyzing(request);

    this.emit(request, {
      step: "analyzing",
      stepNumber: 2,
      totalSteps,
    });

    const unit = units[0];

    if (!unit) {
      throw new NonRetryableRequestError("Request has no analysis unit");
    }

    // A crash after consuming but before finalizing lands here with the
    // result already persisted — reuse it, never re-bill.
    let result = unit.status === "CONSUMED"
      ? (unit.result as unknown as OdometerUnitResult)
      : null;

    if (!result) {
      const descriptor = descriptorByKey.get(unit.unitKey);

      if (!descriptor) {
        throw new NonRetryableRequestError(
          `Persisted input has no descriptor for unit "${unit.unitKey}"`,
        );
      }

      const { parsed } = await this.callProvider(unit, () =>
        this.provider.analyzeOdometerImage(
          descriptor.photoPath,
          input.reportedMileage,
        ),
      );

      result = evaluateOdometerReading(parsed, input.reportedMileage);
      await this.consumeUnit(request, unit, result);
    }

    await writeFuelResult(request.recordId, result);

    const currentResult = {
      status: result.status,
      details: result.details,
      confidence: result.confidence,
      aiReadValue: result.readMileage,
      reportedValue: input.reportedMileage,
    };

    this.emit(request, {
      step: "reading_odometer",
      stepNumber: 3,
      totalSteps,
      currentResult,
    });

    if (result.status === "mismatch" || result.status === "fraud") {
      await this.publishIssueEvent(request, result.status, result.details);
    }

    await this.finalizeRequest(request, "COMPLETED");

    this.emit(request, {
      step: "completed",
      stepNumber: 4,
      totalSteps,
      overallStatus: result.status,
      currentResult,
      usage: await this.usagePayload(request.businessId),
    });

    console.log(
      `[AIAnalysisPipeline] Fuel ${request.recordId} verification completed: ${result.status}`,
    );
  }

  private async processChecklistRequest(
    request: ClaimedRequest,
    units: AIAnalysisUnit[],
    descriptorByKey: Map<string, AnalysisUnitDescriptor>,
  ): Promise<void> {
    const totalSteps = units.length + 2;

    // Only the first attempt announces itself — a retry re-firing "queued"
    // would re-toast "verificação iniciada" at the user mid-analysis.
    if (request.attempts === 1) {
      this.emit(request, {
        step: "queued",
        stepNumber: 1,
        totalSteps,
      });
    }

    await this.markRecordAnalyzing(request);

    let stepNumber = 2;
    let lastUnitError: string | null = null;
    let abortedAsNonRetryable = false;

    for (const unit of units) {
      if (unit.status !== "RESERVED") {
        stepNumber++;
        continue;
      }

      this.emit(request, {
        step: "analyzing_field",
        stepNumber,
        totalSteps,
        fieldName: unit.unitKey,
      });

      stepNumber++;

      const descriptor = descriptorByKey.get(unit.unitKey);

      if (!descriptor) {
        // Input drifted from the persisted units — should not happen; give
        // the unit back instead of charging for nothing.
        lastUnitError = `Persisted input has no descriptor for unit "${unit.unitKey}"`;
        continue;
      }

      // One field failing (corrupt photo, transient API error) must not
      // sink the fields already analyzed — the retry re-runs only what is
      // still reserved.
      try {
        const { parsed } = await this.callProvider(unit, () =>
          this.provider.analyzeChecklistImage(
            descriptor.photoPath,
            unit.unitKey,
            descriptor.reportedValue,
          ),
        );

        await this.consumeUnit(request, unit, evaluateChecklistField(parsed));
      } catch (error) {
        lastUnitError = error instanceof Error ? error.message : String(error);

        // An invalid key fails identically for every remaining field: stop
        // burning calls and fail the request now instead of after backoff.
        if (error instanceof NonRetryableUnitError) {
          abortedAsNonRetryable = true;
          break;
        }
      }
    }

    // Re-read: results persisted by this loop or by a previous attempt.
    const settledUnits = await database.aIAnalysisUnit.findMany({
      where: { requestId: request.id },
    });

    const pendingCount = settledUnits.filter(
      (unit) => unit.status === "RESERVED",
    ).length;

    if (pendingCount > 0) {
      const delay = abortedAsNonRetryable
        ? null
        : nextRetryDelayMs(request.attempts, AI_RETRY_DELAYS_MS);

      if (delay !== null) {
        // Record stays "analyzing"; the retry finishes the reserved units.
        await database.aIAnalysisRequest.update({
          where: { id: request.id },
          data: {
            status: "PENDING",
            availableAt: new Date(Date.now() + delay),
            lastError: lastUnitError,
          },
        });

        return;
      }

      await this.releaseReservedUnits(request);
    }

    const freshResults: Record<string, ChecklistFieldOutcome> = {};

    for (const unit of settledUnits) {
      if (unit.status === "CONSUMED" && unit.result) {
        freshResults[unit.unitKey] =
          unit.result as unknown as ChecklistFieldOutcome;
      }
    }

    const existing = await readChecklistExistingDetails(request.recordId);
    const { merged, overallStatus } = mergeChecklistResults(
      existing,
      freshResults,
    );

    await writeChecklistResults(request.recordId, merged, overallStatus);

    if (overallStatus === "issues_found") {
      await this.publishIssueEvent(
        request,
        overallStatus,
        "Algumas condições informadas não correspondem às fotos.",
      );
    }

    const consumedCount = Object.keys(freshResults).length;

    await this.finalizeRequest(
      request,
      pendingCount === 0
        ? "COMPLETED"
        : consumedCount > 0
          ? "PARTIAL"
          : "FAILED",
      lastUnitError,
    );

    this.emit(request, {
      step: "completed",
      stepNumber: totalSteps,
      totalSteps,
      overallStatus,
      currentResult: {
        status: overallStatus,
        details:
          overallStatus === "error"
            ? "Não foi possível realizar a verificação IA. Tente novamente mais tarde."
            : overallStatus === "issues_found"
              ? "Algumas condições informadas não correspondem às fotos"
              : "Todas as condições verificadas com sucesso",
        fieldsAnalyzed: Object.keys(merged).length,
        fieldResults: merged,
      },
      usage: await this.usagePayload(request.businessId),
    });

    console.log(
      `[AIAnalysisPipeline] Checklist ${request.recordId} verification completed: ${overallStatus}`,
    );
  }

  // ==========================================================================
  // Units, attempts and quota settlement
  // ==========================================================================

  /** Runs a provider call, persisting the attempt row for success and failure. */
  private async callProvider<T>(
    unit: AIAnalysisUnit,
    call: () => Promise<{ parsed: T; usage: ProviderCallUsage }>,
  ): Promise<{ parsed: T; usage: ProviderCallUsage }> {
    const attemptNo =
      (await database.aIProviderAttempt.count({ where: { unitId: unit.id } })) +
      1;

    try {
      const outcome = await call();

      await this.persistAttempt(unit.id, attemptNo, "SUCCEEDED", outcome.usage);

      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.persistAttempt(unit.id, attemptNo, "FAILED", null, message);

      await database.aIAnalysisUnit
        .update({ where: { id: unit.id }, data: { lastError: message } })
        .catch(() => undefined);

      if (isNonRetryableProviderStatus(providerErrorStatus(error))) {
        throw new NonRetryableUnitError(message);
      }

      throw error;
    }
  }

  private async persistAttempt(
    unitId: string,
    attemptNo: number,
    status: "SUCCEEDED" | "FAILED",
    usage: ProviderCallUsage | null,
    errorMessage?: string,
  ): Promise<void> {
    // The trail is an audit, not a coordination point: a concurrent processor
    // hitting the (unitId, attemptNo) unique key is ignored.
    await database.aIProviderAttempt
      .create({
        data: {
          unitId,
          attemptNo,
          provider: usage?.provider ?? PROVIDER_NAME,
          model: usage?.model ?? VISION_MODEL,
          status,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          durationMs: usage?.durationMs,
          errorMessage,
        },
      })
      .catch((error) => {
        console.error(
          `[AIAnalysisPipeline] Falha ao registrar tentativa da unidade ${unitId}:`,
          error,
        );
      });
  }

  /**
   * Persists the unit result and moves its reservation to consumed in one
   * transaction. The status guard makes a racing duplicate processor settle
   * the ledger exactly once.
   */
  private async consumeUnit(
    request: ClaimedRequest,
    unit: AIAnalysisUnit,
    result: OdometerUnitResult | ChecklistUnitResult,
  ): Promise<void> {
    await database.$transaction(async (tx) => {
      const claimed = await tx.aIAnalysisUnit.updateMany({
        where: { id: unit.id, status: "RESERVED" },
        data: {
          status: "CONSUMED",
          result: result as unknown as Prisma.InputJsonValue,
          consumedAt: new Date(),
          lastError: null,
        },
      });

      if (claimed.count === 1) {
        await consumeReservedUnit(tx, request.periodId);
      }
    });
  }

  private async releaseReservedUnits(request: ClaimedRequest): Promise<void> {
    await database.$transaction(async (tx) => {
      const released = await tx.aIAnalysisUnit.updateMany({
        where: { requestId: request.id, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: new Date() },
      });

      if (released.count > 0) {
        await releaseReservedUnits(tx, request.periodId, released.count);
      }
    });
  }

  // ==========================================================================
  // Record + request state
  // ==========================================================================

  private async markRecordAnalyzing(request: ClaimedRequest): Promise<void> {
    try {
      if (request.type === "FUEL_ODOMETER") {
        await markFuelAnalyzing(request.recordId);
      } else {
        await markChecklistAnalyzing(request.recordId);
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw new NonRetryableRequestError(
          "Record no longer exists — analysis is moot",
        );
      }

      throw error;
    }
  }

  private async finalizeRequest(
    request: ClaimedRequest,
    status: "COMPLETED" | "PARTIAL" | "FAILED",
    lastError?: string | null,
  ): Promise<void> {
    await database.aIAnalysisRequest.update({
      where: { id: request.id },
      data: {
        status,
        completedAt: new Date(),
        lastError: lastError ?? null,
      },
    });
  }

  private async recordRequestFailure(
    request: ClaimedRequest,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    const delay =
      error instanceof NonRetryableRequestError ||
      error instanceof NonRetryableUnitError
        ? null
        : nextRetryDelayMs(request.attempts, AI_RETRY_DELAYS_MS);

    console.error(
      `[AIAnalysisPipeline] Falha na análise ${request.id} (tentativa ${request.attempts}):`,
      message,
    );

    if (delay !== null) {
      await database.aIAnalysisRequest
        .update({
          where: { id: request.id },
          data: {
            status: "PENDING",
            availableAt: new Date(Date.now() + delay),
            lastError: message,
          },
        })
        .catch((updateError) => {
          // The lease recovers the row if even this update fails.
          console.error(
            `[AIAnalysisPipeline] Falha ao registrar erro da análise ${request.id}:`,
            updateError,
          );
        });

      return;
    }

    // Retries exhausted (or unfixable): give the reservation back, mark the
    // record so the user is not left staring at "analyzing" forever, close.
    try {
      await this.releaseReservedUnits(request);

      const consumedCount = await database.aIAnalysisUnit.count({
        where: { requestId: request.id, status: "CONSUMED" },
      });

      await this.finalizeRequest(
        request,
        consumedCount > 0 ? "PARTIAL" : "FAILED",
        message,
      );

      if (request.type === "FUEL_ODOMETER") {
        await markFuelError(request.recordId).catch(() => undefined);

        this.emit(request, {
          step: "completed",
          stepNumber: 4,
          totalSteps: 4,
          overallStatus: "error",
          currentResult: {
            status: "error",
            details:
              "Não foi possível realizar a verificação IA. Tente novamente mais tarde.",
          },
          usage: await this.usagePayload(request.businessId),
        });
      }
      // Checklist terminal failures are finalized inside
      // processChecklistRequest, which reaches here only for infrastructure
      // errors; the sweep's next claim settles those.
    } catch (finalizeError) {
      console.error(
        `[AIAnalysisPipeline] Falha ao encerrar análise ${request.id}:`,
        finalizeError,
      );
    }
  }

  // ==========================================================================
  // Websocket events
  // ==========================================================================

  private emit(
    request: ClaimedRequest,
    event: Record<string, unknown>,
  ): void {
    sendAIVerificationEvent(request.requestedById, {
      recordType: request.type === "FUEL_ODOMETER" ? "fuel" : "checklist",
      recordId: request.recordId,
      businessId: request.businessId,
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  private async usagePayload(businessId: string) {
    const usage = await getQuotaUsage(businessId);
    if (!usage) return null;

    return {
      // "used" is what actually happened; reservations still in flight ride
      // in "inProgress" so the UI never counts a running analysis as done.
      used: usage.consumed,
      inProgress: usage.inProgress,
      limit: usage.limit,
      remaining: usage.remaining,
      resetAt: usage.resetAt.toISOString(),
    };
  }

  /**
   * Alerts the business admins that a verification found something
   * actionable. Published BEFORE the request is finalized: a crash in
   * between re-claims the request and republishes, where the unique
   * eventKey deduplicates — the reverse order would lose the alert.
   */
  private async publishIssueEvent(
    request: ClaimedRequest,
    overallStatus: string,
    details: string | null,
  ): Promise<void> {
    try {
      const vehicle =
        request.type === "FUEL_ODOMETER"
          ? (
              await database.fuel.findUnique({
                where: { id: request.recordId },
                select: {
                  vehicle: { select: { license_plate: true, description: true } },
                },
              })
            )?.vehicle
          : (
              await database.vehicleChecklist.findUnique({
                where: { id: request.recordId },
                select: {
                  vehicle: { select: { license_plate: true, description: true } },
                },
              })
            )?.vehicle;

      await this.outbox.publishAfterCommit({
        topic: "ai-verification.issue",
        aggregateType:
          request.type === "FUEL_ODOMETER" ? "fuel" : "vehicle-checklist",
        aggregateId: request.recordId,
        businessId: request.businessId,
        actorId: request.requestedById,
        eventKey: `ai-verification.issue:${request.id}`,
        payload: {
          recordType: request.type === "FUEL_ODOMETER" ? "fuel" : "checklist",
          recordId: request.recordId,
          businessId: request.businessId,
          vehiclePlate: vehicle?.license_plate ?? null,
          vehicleDescription: vehicle?.description ?? null,
          overallStatus,
          details,
        },
      });
    } catch (error) {
      // A crash-replay hits the unique eventKey: the alert already exists.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }

      // The alert is best-effort: losing it must not fail the analysis that
      // already produced and persisted its result.
      console.error(
        `[AIAnalysisPipeline] Falha ao publicar alerta de divergência da análise ${request.id}:`,
        error,
      );
    }
  }
}

export { AIAnalysisPipelineService };
