import database from "@/../infra/database";
import { env } from "@/env";
import { AIAnalysisType, AIAnalysisUnit, Prisma } from "@prisma/client";

import { sendAIVerificationEvent } from "@/websocket";

import { nextRetryDelayMs, withRetryJitter } from "@/shared/notifications/pipeline-rules";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

import {
  assessProof,
  describeAssessment,
  describeProblems,
  driverFeedbackFor,
  type ProofAssessment,
  type ProofCriteriaReading,
  type ProofDriverFeedback,
} from "./proof-criteria";

import {
  AIAnalysisProvider,
  AI_IMAGE_FETCH_TIMEOUT_MS,
  ImageUnavailableError,
  PaidInvalidResponseError,
} from "./ai-provider";
import { checklistFieldSpec } from "./ai-prompts";
import { LOCAL_AI_MAX_RETRIES } from "./ai-provider-defaults";
import { consumeReservedUnit, getQuotaUsage, releaseReservedUnits } from "./ai-quota-service";
import {
  AI_CLAIM_LEASE_SECONDS,
  FRAUD_NOT_ASSESSED_NOTE,
  FRAUD_NOT_ASSESSED_PREFIX,
  ChecklistFieldOutcome,
  aiRecordTypeOf,
  assertAILeaseInvariant,
  buildAnalysisUnits,
  checklistReadingKind,
  evaluateChecklistField,
  evaluateOdometerReading,
  isCurrentProofInput,
  readProofExtraction,
  restoreOdometerResult,
  unitConfidence,
  type ChecklistReading,
} from "./ai-rules";
import { countDeviceAgreement } from "@/shared/ai-precheck/device-agreement-metrics";
import {
  attachProofSuggestion,
  markChecklistAnalyzing,
  markChecklistSkipped,
  markFuelSkipped,
  proofCardAwaitsReading,
  markFuelAnalyzing,
  markFuelError,
  writeChecklistVerdict,
  writeFuelResult,
} from "./ai-record-store";
import {
  AIAnalysisInputMap,
  AnalysisUnitDescriptor,
  ChecklistUnitResult,
  OdometerUnitResult,
  ProviderCallUsage,
} from "./ai-types";
import type { ReadingKind } from "./image-reader";
import { ProviderCircuit, type CircuitSnapshot } from "./provider-circuit";
import {
  INPUT_SUPERSEDED_MARKER,
  INVALID_RESPONSE_MARKER,
  PROVIDER_PAUSED_MARKER,
  UNSUPPORTED_BY_READER_MARKER,
} from "./provider-failure";

/** The shared logger (OBS-14): each line names the request it is about. */
const log = logger.child({ component: "ai-pipeline" });

/**
 * Same wake-driven shape as the notification pipeline: `requestAnalysis`
 * wakes processing right after commit, and the interval is only a background
 * sweep for retries, leases orphaned by a dead replica and requests created
 * by other replicas. A dedicated worker replica (WORKERS_ENABLED) is woken by
 * nobody and polls faster.
 */
const SWEEP_INTERVAL_MS = env.PIPELINE_SWEEP_INTERVAL_MS;

/**
 * A replica dying mid-request only delays the retry by this window —
 * consumed units keep their results and are not re-billed. Renewed before
 * every provider call, so it covers one unit however long the checklist.
 */
const CLAIM_LEASE_SECONDS = AI_CLAIM_LEASE_SECONDS;

// A unit that can outlive its lease gets its photo read twice and settled by
// two owners: fail the boot instead (INV-09). The budget is the configured
// reader's (AI_LOCAL_TIMEOUT_MS, no client retry), so a timeout that does not
// fit stops the boot even while AI_PROVIDER=none.
assertAILeaseInvariant({
  providerTimeoutMs: env.AI_LOCAL_TIMEOUT_MS,
  providerMaxRetries: LOCAL_AI_MAX_RETRIES,
  imageFetchTimeoutMs: AI_IMAGE_FETCH_TIMEOUT_MS,
  leaseSeconds: CLAIM_LEASE_SECONDS,
});

/**
 * Requests in flight per replica, at most. A request is claimed only when a
 * slot is free to run it: the old batch of 2 was processed one after the
 * other, so the second row sat with its lease running behind the first
 * (GAP2-2). The reader lowers it (maxConcurrency): the local OCR reads one
 * photo at a time, so a replica keeps AI_LOCAL_MAX_CONCURRENCY in flight.
 */
const AI_CONCURRENCY = 4;

/**
 * How long a request the reader turned away as busy (its queue full, HTTP
 * 503) waits before it is claimable again: 5–15 s, jittered so the replicas
 * do not come back in step. Not an attempt, not a failure (ADR 0010 §3.2).
 */
const AI_BUSY_RETRY_MIN_MS = 5_000;
const AI_BUSY_RETRY_SPREAD_MS = 10_000;

function busyRetryDelayMs(random: () => number = Math.random): number {
  return AI_BUSY_RETRY_MIN_MS + Math.floor(random() * AI_BUSY_RETRY_SPREAD_MS);
}

/** Backoff between attempts; length + 1 also caps the attempts. */
const AI_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

/**
 * A request claimed with more attempts than this was interrupted during its
 * last allowed one (a crash, a deploy, a hang past the lease): it is failed
 * without calling the provider again, instead of being re-claimed forever.
 */
const AI_MAX_ATTEMPTS = AI_RETRY_DELAYS_MS.length + 1;

/**
 * The backoff step, spread by +/-20% (the notification pipeline's jitter): a
 * provider outage fails a whole claim pool at the same instant, and without
 * the spread every replica's retries came back as one burst at +30 s.
 */
function aiRetryDelayMs(attempts: number): number | null {
  const base = nextRetryDelayMs(attempts, AI_RETRY_DELAYS_MS);

  return base === null ? null : withRetryJitter(base);
}

/**
 * Invalid answers a unit gets before it is given up (AI-14): one more try —
 * a model can garble one answer — and not the four a transient failure gets,
 * each of them paid.
 */
const AI_MAX_INVALID_ANSWERS = 2;

/** The outbox topic that tells the driver about a receipt that looks wrong. */
const PROOF_FEEDBACK_TOPIC = "delivery-proof.ai-flagged";

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
 * This unit will fail identically on every retry (the provider refused the
 * request itself, the answer was invalid twice, the photo does not exist).
 * The unit is given back; the rest of a checklist carries on.
 */
class PermanentUnitError extends Error {}

/**
 * The provider refused our key (401/403). Fails the request — the credential
 * alert reads it — and pauses the pipeline so the backlog is not failed too.
 */
class ProviderUnauthorizedError extends Error {}

/**
 * The provider will not serve anybody right now: spend limit, our own usage
 * limit, billing (AI-8). The request goes back to the queue without spending
 * the attempt, and the pipeline stops claiming until the circuit's probe.
 */
class ProviderPausedError extends Error {}

/**
 * The reader is up but its queue is full (the OCR service's 503). The
 * request goes back to the queue for 5–15 s without spending the attempt;
 * the circuit is not opened (ADR 0010 §3.2).
 */
class ProviderBusyError extends Error {}

/**
 * This replica no longer owns the request: its lease ran out and another
 * replica claimed it (the claim bumped `attempts`). Whatever this one was
 * doing is dropped without a write — the new owner settles the request.
 */
class LeaseLostError extends Error {
  constructor(requestId: string) {
    super(`Lease lost on AI request ${requestId}`);
  }
}

/** What a receipt's reading produced, as the unit and the card keep it. */
interface ProofSuggestionRecord {
  version: 2;
  reading: ProofCriteriaReading;
  assessment: ProofAssessment;
}

/**
 * Consumes AIAnalysisRequest rows: claims with `FOR UPDATE SKIP LOCKED` +
 * lease, calls the vision model per unit, persists the attempt trail and the
 * per-unit results, settles the quota ledger and writes the verdict back to
 * the Fuel/VehicleChecklist record or the proof's card — emitting the same
 * `aiVerification` websocket steps the frontends already understand.
 */
class AIAnalysisPipelineService {
  private static instance: AIAnalysisPipelineService;

  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;

  /** Set by shutdown: the cycle stops claiming and lets in-flight work end. */
  private stopping = false;

  /**
   * Something the running cycle has to look at the queue for: a slot freed,
   * or a wake or sweep that found the cycle already running. Reset by every
   * claim, which answers all of them at once.
   */
  private rescanRequested = false;

  /** Ends the running cycle's wait early; null while it is not waiting. */
  private interruptWait: (() => void) | null = null;

  /** Reads the photos. Replaced by tests with a fake provider behind it. */
  private provider = new AIAnalysisProvider();

  /** Whether the provider may be called now (AI-8). */
  private circuit = new ProviderCircuit();

  private outbox = new OutboxService();

  private constructor() {}

  public static getInstance(): AIAnalysisPipelineService {
    if (!AIAnalysisPipelineService.instance) {
      AIAnalysisPipelineService.instance = new AIAnalysisPipelineService();
    }

    return AIAnalysisPipelineService.instance;
  }

  public async initialize(): Promise<void> {
    this.stopping = false;

    this.sweepTimer = setInterval(() => {
      this.runCycle().catch((error) => {
        log.error({ err: error }, "AI pipeline cycle failed");
      });
    }, SWEEP_INTERVAL_MS);

    // No drain here: the boot drains once Socket.IO is up, so the
    // aiVerification events of the backlog reach the clients
    // (shared/lifecycle/startup.ts, OUTBOX-19).

    log.info("AI analysis pipeline started");
  }

  /**
   * Processes pending requests now instead of waiting for the sweep.
   *
   * Outside the request that queued the analysis: `wake` is called from
   * inside it, and the cycle it starts drains every tenant's pending work.
   * Inheriting the request's AsyncLocalStorage stamped that one request's id
   * on the alerts published for all of them (OBS-06).
   */
  public wake(): void {
    // On an HTTP-only replica (WORKERS_ENABLED=false) a request queues its
    // analysis and drains nothing: the worker service's sweep takes it.
    if (!env.WORKERS_ENABLED) return;

    withoutRequestContext(() => {
      this.runCycle().catch((error) => {
        log.error({ err: error }, "AI pipeline wake failed");
      });
    });
  }

  public async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    this.stopping = true;

    // Let in-flight requests finish; the lease covers anything interrupted.
    const deadline = Date.now() + 10_000;

    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    log.info("AI analysis pipeline stopped");
  }

  /** The provider circuit as /health reports it (this replica's view). */
  public providerCircuit(): CircuitSnapshot {
    return this.circuit.snapshot();
  }

  /**
   * Whether the configured reader answers this kind (ADR 0010 §5). The
   * request service asks HERE, so the units it creates are the ones this
   * pipeline can read — tests that swap the reader stay consistent.
   */
  public supports(kind: ReadingKind): boolean {
    const supports = (this.provider as { supports?: (kind: ReadingKind) => boolean })
      .supports;

    // An analyzer without the method (a test double of the queue mechanics)
    // reads everything.
    return typeof supports === "function" ? supports.call(this.provider, kind) : true;
  }

  /** Requests in flight: the pool, lowered by what the reader takes. */
  private slots(): number {
    const readerMax = (this.provider as { maxConcurrency?: unknown }).maxConcurrency;

    return typeof readerMax === "number" && readerMax >= 1
      ? Math.min(AI_CONCURRENCY, Math.floor(readerMax))
      : AI_CONCURRENCY;
  }

  private requestRescan(): void {
    this.rescanRequested = true;
    this.interruptWait?.();
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      // A wake or the sweep while requests are on the provider: the new work
      // goes to the free slots now. Returning without a word left it waiting
      // for one of the running requests to END, so a single hung call held
      // every analysis queued after it with three slots idle (GAP2-2).
      this.requestRescan();
      return;
    }

    this.running = true;

    // A hung await here keeps the flag set forever; the beats make that
    // visible on /health/metrics (OBS-10).
    workerHeartbeat.beginCycle("ai-analysis");

    // A bounded pool: up to AI_CONCURRENCY requests in flight, and a row is
    // claimed only when a slot is free to run it — never ahead of one, where
    // its lease would run out while it waited.
    const inFlight = new Set<Promise<void>>();

    try {
      for (;;) {
        // This claim answers every rescan asked for before it.
        this.rescanRequested = false;

        // With the provider refusing service the requests stay PENDING —
        // due, so the lag alert sees them — instead of spending their
        // attempts; after the cooldown one goes through as the probe.
        const probing = this.circuit.snapshot().state !== "closed";
        const free = this.circuit.claimable(this.slots() - inFlight.size);

        let requests: ClaimedRequest[] = [];

        if (free > 0 && !this.stopping) {
          requests = await this.claimRequests(free);

          if (probing && requests.length > 0) this.circuit.markProbeStarted();

          // Only a claim that ran is progress. A sweep waking a cycle whose
          // every slot is hung must leave the beat alone, or the stuck
          // detector would never see those four calls.
          workerHeartbeat.progress("ai-analysis");
        }

        for (const request of requests) {
          const task: Promise<void> = this.runOne(request).finally(() => {
            inFlight.delete(task);

            // A probe that ended without an answer from the provider (its
            // record gone, its lease lost) frees the next one.
            if (probing) this.circuit.releaseProbe();

            // A slot freed is the moment to look at the queue again: new
            // work may have arrived, or a full claim may have left more.
            this.requestRescan();
          });

          inFlight.add(task);
        }

        // Asked for during the claim: its snapshot may predate that work.
        if (this.rescanRequested) continue;

        if (inFlight.size === 0) break;

        await new Promise<void>((resolve) => {
          this.interruptWait = resolve;
        });

        this.interruptWait = null;
      }
    } finally {
      await Promise.allSettled(inFlight);

      this.running = false;
      workerHeartbeat.endCycle("ai-analysis");
    }
  }

  /** One request, start to settle. Never rejects: the pool must not stall. */
  private async runOne(request: ClaimedRequest): Promise<void> {
    try {
      await this.processRequest(request);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Another replica owns it now and settles it; any write from here
        // would land over its work.
        log.warn(
          { requestId: request.id, attempt: request.attempts },
          "AI analysis taken over by another replica; this replica's work is dropped",
        );
        return;
      }

      try {
        await this.recordRequestFailure(request, error);
      } catch (failureError) {
        log.error(
          { err: failureError, requestId: request.id },
          "AI analysis failure could not be recorded",
        );
      }
    }
  }

  /**
   * Claims up to `limit` due requests, the oldest of EACH company first.
   *
   * Ordered by age alone, one company's 500 queued proofs put every other
   * company's analyses 500 calls behind. Ranking each company's queue and
   * taking the first of every company before anybody's second keeps the
   * wait of a small tenant independent of a large one's backlog (GAP2-2).
   *
   * `FOR UPDATE` cannot sit at the level of a window function, so the rank
   * is a subquery and the lock is on the outer rows; SKIP LOCKED with the
   * LIMIT above it walks past rows another replica is claiming right now
   * instead of coming back short. The statuses are spelled as literals so
   * the partial ai_analysis_request_fair_claim_idx is provable.
   */
  private async claimRequests(limit: number): Promise<ClaimedRequest[]> {
    return database.$queryRaw<ClaimedRequest[]>`
      UPDATE "ai_analysis_request" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "candidate"."id"
        FROM "ai_analysis_request" AS "candidate"
        JOIN (
          -- (businessId, created_at) is exactly the order of the partial
          -- index, so the window reads it without a sort.
          SELECT "id", "created_at",
                 row_number() OVER (
                   PARTITION BY "businessId" ORDER BY "created_at"
                 ) AS "position"
          FROM "ai_analysis_request"
          WHERE "status" IN ('PENDING', 'PROCESSING')
            AND (("status" = 'PENDING' AND "availableAt" <= now())
              OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now()))
        ) AS "ranked" ON "ranked"."id" = "candidate"."id"
        -- Checked again under the lock: another replica may have taken it.
        WHERE ("candidate"."status" = 'PENDING' AND "candidate"."availableAt" <= now())
           OR ("candidate"."status" = 'PROCESSING' AND "candidate"."leaseExpiresAt" < now())
        ORDER BY "ranked"."position", "ranked"."created_at", "ranked"."id"
        LIMIT ${limit}
        FOR UPDATE OF "candidate" SKIP LOCKED
      )
      RETURNING "id", "type", "recordId", "businessId", "periodId",
                "requestedById", "input", "attempts"
    `;
  }

  /**
   * The claim's identity, for every write that settles or re-queues the
   * request: the same row, still PROCESSING, at the attempt THIS replica
   * claimed. A re-claim bumped `attempts`, so a stale owner matches nothing.
   */
  private fenced(request: ClaimedRequest) {
    return {
      id: request.id,
      status: "PROCESSING" as const,
      attempts: request.attempts,
    };
  }

  /**
   * Pushes the lease forward before a provider call, so a checklist of a
   * dozen photos is covered one unit at a time. Throws LeaseLostError when
   * the request is no longer this replica's — it stops before paying for a
   * photo the new owner is going to analyse (INV-09).
   */
  private async renewLease(request: ClaimedRequest): Promise<void> {
    const renewed = await database.$executeRaw`
      UPDATE "ai_analysis_request"
      SET "leaseExpiresAt" = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS})
      WHERE "id" = ${request.id}
        AND "status" = 'PROCESSING'
        AND "attempts" = ${request.attempts}
    `;

    if (renewed !== 1) throw new LeaseLostError(request.id);
  }

  // ==========================================================================
  // Request processing
  // ==========================================================================

  private async processRequest(request: ClaimedRequest): Promise<void> {
    // The claim bumps `attempts` whether or not the attempt ever reported
    // back. Past the budget, the last allowed attempt was interrupted — a
    // crash, a deploy, a hang past the lease — and one that crashes the
    // process would be re-claimed forever: settle it instead.
    if (request.attempts > AI_MAX_ATTEMPTS) {
      throw new NonRetryableRequestError(
        "O processo foi interrompido durante a última tentativa permitida.",
      );
    }

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
    } else if (request.type === "DELIVERY_PROOF") {
      await this.processProofRequest(request, units, descriptorByKey);
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

    const unit = units[0];

    if (!unit) {
      throw new NonRetryableRequestError("Request has no analysis unit");
    }

    // Only while the fuelling still holds the photo and mileage this request
    // read (AI-4). One replaced since then has its own request; paying to
    // read the old photo would buy a verdict nobody may show.
    const current = await markFuelAnalyzing(request.recordId, input);

    if (!current && unit.status === "RESERVED") {
      await this.settleSuperseded(request);
      return;
    }

    // Queued under a reader that read odometers, found by one that does not:
    // given back, never read (ADR 0010 §5).
    if (unit.status === "RESERVED" && !this.supports("odometer")) {
      await this.settleUnsupported(request, "SKIPPED");
      await markFuelSkipped(request.recordId).catch(() => undefined);
      return;
    }

    // Only the first attempt announces itself — a retry re-firing "queued"
    // would re-toast "verificação iniciada" at the user mid-analysis.
    if (request.attempts === 1) {
      this.emit(request, { step: "queued", stepNumber: 1, totalSteps });
    }

    this.emit(request, { step: "analyzing", stepNumber: 2, totalSteps });

    // A crash after consuming but before finalizing lands here with the
    // result already persisted — reuse it, never re-bill.
    let result: OdometerUnitResult | null =
      unit.status === "CONSUMED"
        ? restoreOdometerResult(unit.result, input.reportedMileage)
        : null;

    if (!result) {
      const descriptor = descriptorByKey.get(unit.unitKey);

      if (!descriptor) {
        throw new NonRetryableRequestError(
          `Persisted input has no descriptor for unit "${unit.unitKey}"`,
        );
      }

      await this.renewLease(request);

      const { parsed } = await this.callProvider(unit, () =>
        this.provider.analyzeOdometerImage(descriptor.photoPath),
      );

      result = evaluateOdometerReading(parsed, input.reportedMileage);
      await this.consumeUnit(request, unit, result);
    }

    // Still ours before the record is written, as in the checklist. A stale
    // owner — its call answered after the lease ran out and another replica
    // re-claimed the request — wrote its reading over the new owner's and
    // told the user about it. The unit it consumed keeps the paid result, and
    // an owner that finds the unit consumed reuses it instead of calling.
    await this.renewLease(request);

    const { written, deviceAgreement } = await writeFuelResult(
      request.recordId,
      input,
      result,
    );

    countDeviceAgreement("fuel_odometer", deviceAgreement);

    if (!written) {
      // The photo or the mileage changed while the model was reading: the
      // paid result stays on the unit, the record keeps the newer request's
      // verdict, and nobody is told about a reading of a photo that is gone.
      await this.finalizeRequest(request, "COMPLETED");

      log.info(
        { requestId: request.id, fuelId: request.recordId },
        "fuel reading superseded by a newer input; not written",
      );

      return;
    }

    const currentResult = {
      status: result.status,
      details: result.details,
      confidence: result.confidence,
      aiReadValue: result.readMileage,
      reportedValue: input.reportedMileage,
      // "verified" from a reader that cannot judge fraud means "km confere":
      // the screens must not draw the "Verificado" seal for it (ADR 0010 §5).
      ...(result.fraudAssessed === false ? { fraudAssessed: false } : {}),
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

    log.info(
      {
        requestId: request.id,
        fuelId: request.recordId,
        businessId: request.businessId,
        status: result.status,
      },
      "fuel verification completed",
    );
  }

  /**
   * The receipt photo, read once and written as a SUGGESTION.
   *
   * Nothing here decides anything about the delivery. The card was already in
   * the queue when the driver proved it; this only fills in what the model
   * read, compared in code with what the delivery expected (decision 6.9),
   * and a card whose model never answered still reaches a person — which is
   * the right outcome, because a photo the machine could not read is exactly
   * the one a human has to.
   */
  private async processProofRequest(
    request: ClaimedRequest,
    units: AIAnalysisUnit[],
    descriptorByKey: Map<string, AnalysisUnitDescriptor>,
  ): Promise<void> {
    const input = request.input as AIAnalysisInputMap["DELIVERY_PROOF"];
    const totalSteps = 3;

    const unit = units[0];

    if (!unit) {
      throw new NonRetryableRequestError("Request has no analysis unit");
    }

    // Only while a card still waits for a reading of THIS photo (AI-4), as
    // the fuel and checklist paths check before their call: after a re-proof
    // or a reviewer's decision the old photo's reading is moot, and paying
    // the provider for it charged the quota for a suggestion nobody may see.
    //
    // Settled COMPLETED, not SKIPPED: on a receipt SKIPPED is the quota's
    // refusal, and the audit card read it as "Limite de leituras atingido"
    // for every card decided before its reading was claimed. Nothing is
    // lost by not reviving it — the same photo is never asked for again.
    if (
      unit.status === "RESERVED" &&
      !(await proofCardAwaitsReading(
        request.recordId,
        request.businessId,
        input.photoPath,
      ))
    ) {
      await this.settleSuperseded(request, "COMPLETED");
      return;
    }

    // COMPLETED, not SKIPPED: on a receipt SKIPPED reads as the quota's
    // refusal. The card stays in the human queue, without a suggestion.
    if (unit.status === "RESERVED" && !this.supports("proof")) {
      await this.settleUnsupported(request, "COMPLETED");
      return;
    }

    if (request.attempts === 1) {
      this.emit(request, { step: "queued", stepNumber: 1, totalSteps });
    }

    this.emit(request, { step: "analyzing", stepNumber: 2, totalSteps });

    let record: ProofSuggestionRecord;

    if (unit.status === "CONSUMED") {
      // Paid already: a previous attempt consumed the unit and then failed
      // to write the card (or crashed). The reading is on the unit — attach
      // it now instead of finishing without it (AI-5).
      record = unit.result as unknown as ProofSuggestionRecord;
    } else if (unit.status === "RESERVED") {
      const descriptor = descriptorByKey.get(unit.unitKey);

      if (!descriptor) {
        throw new NonRetryableRequestError(
          `Persisted input has no descriptor for unit "${unit.unitKey}"`,
        );
      }

      // Looked up before the call: a failure after it would pay twice.
      const legacyInvoice = await this.legacyProofInvoice(request, input);

      await this.renewLease(request);

      const { parsed } = await this.callProvider(unit, () =>
        this.provider.analyzeDeliveryProof(descriptor.photoPath),
      );

      const reading = readProofExtraction(parsed, input, legacyInvoice);

      record = { version: 2, reading, assessment: assessProof(reading) };

      // The unit keeps the whole reading, so a later question — "what did
      // the model actually say about this photo?" — has an answer that does
      // not depend on the card still existing.
      await this.consumeUnit(request, unit, record);
    } else {
      // Given back already (RELEASED): nothing was read, nothing to attach.
      await this.finalizeRequest(request, "COMPLETED");
      return;
    }

    // Still ours before the card is written.
    await this.renewLease(request);

    // Only onto the card of THIS photo, still waiting for a person (AI-4).
    const { attached, deviceAgreement } = await attachProofSuggestion(
      request.recordId,
      request.businessId,
      input.photoPath,
      record,
      unitConfidence(record.reading?.confidence),
    );

    countDeviceAgreement("proof", deviceAgreement);

    // A receipt that looks wrong, or a photo too poor to read (decision 6.9).
    const feedback = record.assessment
      ? driverFeedbackFor(record.reading, record.assessment)
      : null;

    if (attached === 1 && feedback) {
      await this.publishProofFeedback(request, feedback, input.expectedRecipient);
    }

    await this.finalizeRequest(request, "COMPLETED");

    if (attached === 1) {
      this.emit(request, {
        step: "completed",
        stepNumber: totalSteps,
        totalSteps,
        overallStatus: record.assessment?.suggestion ?? "needs_review",
        currentResult: proofResultPayload(record),
      });
    }
  }

  /**
   * The NF-e number the delivery holds, asked only for an input queued before
   * decision 6.9: its expected document may be the delivery's code, and is
   * compared only when it is this number (expectedProofNumber).
   */
  private async legacyProofInvoice(
    request: ClaimedRequest,
    input: AIAnalysisInputMap["DELIVERY_PROOF"],
  ): Promise<string | null> {
    if (isCurrentProofInput(input)) return null;

    const delivery = await database.delivery.findFirst({
      where: { id: request.recordId, businessId: request.businessId },
      select: { invoice_number: true },
    });

    return delivery?.invoice_number ?? null;
  }

  private async processChecklistRequest(
    request: ClaimedRequest,
    units: AIAnalysisUnit[],
    descriptorByKey: Map<string, AnalysisUnitDescriptor>,
  ): Promise<void> {
    const input = request.input as AIAnalysisInputMap["CHECKLIST"];
    const totalSteps = units.length + 2;

    // Only the fields whose photo is still the record's (AI-4): a field
    // replaced since has its own request, and reading the old photo would buy
    // a verdict nobody may show.
    const currentFields = await markChecklistAnalyzing(
      request.recordId,
      input.photosByField,
    );

    if (
      currentFields.size === 0 &&
      units.every((unit) => unit.status !== "CONSUMED")
    ) {
      await this.settleSuperseded(request);
      return;
    }

    // Only the first attempt announces itself — a retry re-firing "queued"
    // would re-toast "verificação iniciada" at the user mid-analysis.
    if (request.attempts === 1) {
      this.emit(request, { step: "queued", stepNumber: 1, totalSteps });
    }

    // A field the request did not carry a value for (an edit that changed
    // only the photo) is compared with the value the record holds.
    const informedOnRecord = await this.checklistValues(request.recordId);

    let stepNumber = 2;
    let lastUnitError: string | null = null;
    let aborted: "unauthorized" | "paused" | "busy" | null = null;
    let releasedUnsupported = 0;

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
        // the unit back instead of charging for nothing, now rather than
        // after every retry.
        lastUnitError = `Persisted input has no descriptor for unit "${unit.unitKey}"`;
        await this.releaseUnit(request, unit, lastUnitError);
        continue;
      }

      if (!currentFields.has(unit.unitKey)) {
        await this.releaseUnit(
          request,
          unit,
          `${INPUT_SUPERSEDED_MARKER}: a foto deste item foi trocada.`,
        );
        continue;
      }

      const informed =
        descriptor.reportedValue !== undefined
          ? descriptor.reportedValue
          : informedOnRecord[unit.unitKey];

      // Reserved under a reader that read this kind of item (a vision model:
      // fuel gauge, tyres, "working" items), found by one that does not:
      // given back with its quota, never read (ADR 0010 §5).
      if (!this.supports(checklistReadingKind(unit.unitKey, informed))) {
        await this.releaseUnit(request, unit, UNSUPPORTED_BY_READER_MARKER);
        releasedUnsupported++;
        continue;
      }

      // Outside the per-field try: a lost lease is not a field failure, it
      // ends this replica's work on the request (INV-09).
      await this.renewLease(request);

      // One field failing (corrupt photo, transient API error) must not
      // sink the fields already analyzed — the retry re-runs only what is
      // still reserved.
      try {
        const spec = checklistFieldSpec(unit.unitKey, informed);

        const { parsed } = await this.callProvider(unit, () =>
          this.provider.analyzeChecklistImage(descriptor.photoPath, spec),
        );

        const result = evaluateChecklistField(
          { kind: spec.kind, answer: parsed } as ChecklistReading,
          informed,
        );

        await this.consumeUnit(request, unit, result);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;

        lastUnitError = error instanceof Error ? error.message : String(error);

        if (error instanceof PermanentUnitError) {
          await this.releaseUnit(request, unit, lastUnitError);
          continue;
        }

        // The provider refuses everybody: stop spending calls on the rest.
        if (error instanceof ProviderUnauthorizedError) {
          aborted = "unauthorized";
          break;
        }

        if (error instanceof ProviderPausedError) {
          aborted = "paused";
          break;
        }

        // The reader's queue is full: the rest of the fields wait with it.
        if (error instanceof ProviderBusyError) {
          aborted = "busy";
          break;
        }
      }
    }

    if (aborted === "paused") {
      // Nothing about the checklist is wrong: back to the queue as it is,
      // fields already read kept, the attempt not spent.
      await this.pauseRequest(request, lastUnitError);
      return;
    }

    if (aborted === "busy") {
      // Back-pressure: the same, a few seconds later.
      await this.deferBusyRequest(request);
      return;
    }

    // Re-read: results persisted by this loop or by a previous attempt.
    const settledUnits = await database.aIAnalysisUnit.findMany({
      where: { requestId: request.id },
    });

    const pendingCount = settledUnits.filter(
      (unit) => unit.status === "RESERVED",
    ).length;

    // Every unit given back as not covered and none ever read: there is no
    // verdict to write — "error" would blame a failure that never happened.
    // The record says "not analysed", as when nothing is covered at request
    // time (AIAnalysisService).
    if (
      releasedUnsupported > 0 &&
      pendingCount === 0 &&
      settledUnits.every((unit) => unit.status !== "CONSUMED")
    ) {
      await this.finalizeRequest(request, "COMPLETED", UNSUPPORTED_BY_READER_MARKER);
      await markChecklistSkipped(request.recordId).catch(() => undefined);
      return;
    }

    if (pendingCount > 0 && aborted === null) {
      const delay = aiRetryDelayMs(request.attempts);

      if (delay !== null) {
        // Record stays "analyzing"; the retry finishes the reserved units.
        // Fenced: a stale owner must not put back in the queue a request a
        // newer owner is working on, or has finished.
        const requeued = await database.aIAnalysisRequest.updateMany({
          where: this.fenced(request),
          data: {
            status: "PENDING",
            availableAt: new Date(Date.now() + delay),
            lastError: lastUnitError,
          },
        });

        if (requeued.count === 0) throw new LeaseLostError(request.id);

        return;
      }
    }

    // Still ours before the record is written: a stale owner stops here.
    await this.renewLease(request);

    const verdict = await this.writeChecklistVerdict(request, settledUnits);

    if (verdict.written && verdict.overallStatus === "issues_found") {
      await this.publishIssueEvent(
        request,
        verdict.overallStatus,
        "Algumas condições informadas não correspondem às fotos.",
      );
    }

    // Settles the request and gives back what is still reserved, in one
    // fenced transaction (units no longer ours are never released).
    await this.finalizeRequest(
      request,
      pendingCount === 0
        ? "COMPLETED"
        : verdict.consumedCount > 0
          ? "PARTIAL"
          : "FAILED",
      lastUnitError,
    );

    if (verdict.written) {
      await this.emitChecklistCompleted(
        request,
        totalSteps,
        verdict.merged,
        verdict.overallStatus,
      );
    }

    log.info(
      {
        requestId: request.id,
        checklistId: request.recordId,
        businessId: request.businessId,
        status: verdict.overallStatus,
        written: verdict.written,
      },
      "checklist verification completed",
    );
  }

  /** The informed values on the checklist row, for fields a request lacks. */
  private async checklistValues(
    recordId: string,
  ): Promise<Record<string, unknown>> {
    const row = await database.vehicleChecklist.findUnique({
      where: { id: recordId },
    });

    return (row ?? {}) as Record<string, unknown>;
  }

  /**
   * The fields analysed so far — by this attempt or an earlier one — merged
   * onto what the record already held, only where the record still holds the
   * photo they read, and written to it: "error" when not one field could be
   * analysed.
   */
  private async writeChecklistVerdict(
    request: ClaimedRequest,
    units: AIAnalysisUnit[],
  ) {
    const input = request.input as AIAnalysisInputMap["CHECKLIST"];
    const freshResults: Record<string, ChecklistFieldOutcome> = {};

    for (const unit of units) {
      if (unit.status === "CONSUMED" && unit.result) {
        const outcome = unit.result as unknown as ChecklistFieldOutcome;

        // Results paid before the 0–1 scale keep their meaning (AI-3).
        freshResults[unit.unitKey] = {
          ...outcome,
          confidence: unitConfidence(outcome.confidence),
        };
      }
    }

    const verdict = await writeChecklistVerdict(
      request.recordId,
      input.photosByField,
      freshResults,
    );

    countDeviceAgreement("checklist_mileage", verdict.deviceAgreement ?? null);

    return { ...verdict, consumedCount: Object.keys(freshResults).length };
  }

  private async emitChecklistCompleted(
    request: ClaimedRequest,
    totalSteps: number,
    merged: Record<string, ChecklistFieldOutcome>,
    overallStatus: "verified" | "issues_found" | "error",
  ): Promise<void> {
    // A field read without a fraud check (OCR odometer): "verified" there
    // only means the numbers agree, so the sentence must not say more.
    const fraudUnassessed = Object.values(merged).some(
      (outcome) => outcome.fraudAssessed === false,
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
              : fraudUnassessed
                ? `${FRAUD_NOT_ASSESSED_PREFIX}. ${FRAUD_NOT_ASSESSED_NOTE}`
                : "Todas as condições verificadas com sucesso",
        fieldsAnalyzed: Object.keys(merged).length,
        fieldResults: merged,
        ...(fraudUnassessed ? { fraudAssessed: false } : {}),
      },
      usage: await this.usagePayload(request.businessId),
    });
  }

  // ==========================================================================
  // Units, attempts and quota settlement
  // ==========================================================================

  /**
   * Runs a provider call, persisting the attempt row for success and failure,
   * and turns a failure into what the pipeline does about it (AI-8, AI-14).
   */
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
      this.circuit.recordSuccess();

      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Busy is back-pressure, not a failed attempt: no FAILED row in the
      // audit trail, the unit's lastError untouched, and attemptNo does not
      // climb while the reader's queue is full.
      if (
        !(error instanceof PaidInvalidResponseError) &&
        !(error instanceof ImageUnavailableError) &&
        this.provider.classifyError(error) === "busy"
      ) {
        this.circuit.recordFailure("busy");

        log.info(
          { unitId: unit.id },
          "AI reader busy (queue full); request deferred without spending an attempt",
        );

        throw new ProviderBusyError(message);
      }

      await this.persistAttempt(
        unit.id,
        attemptNo,
        "FAILED",
        error instanceof PaidInvalidResponseError ? error.usage : null,
        message,
      );

      await database.aIAnalysisUnit
        .update({ where: { id: unit.id }, data: { lastError: message } })
        .catch(() => undefined);

      if (error instanceof PaidInvalidResponseError) {
        // The provider answered: it is up. The answer is what failed.
        this.circuit.recordSuccess();

        const invalidSoFar = await database.aIProviderAttempt.count({
          where: {
            unitId: unit.id,
            status: "FAILED",
            // The marker's "_" is a LIKE wildcard: matched literally.
            errorMessage: { startsWith: escapeLikePattern(INVALID_RESPONSE_MARKER) },
          },
        });

        if (invalidSoFar >= AI_MAX_INVALID_ANSWERS) {
          throw new PermanentUnitError(message);
        }

        throw error;
      }

      if (error instanceof ImageUnavailableError) {
        // Our storage, not the provider: the circuit is not told.
        if (error.permanent) throw new PermanentUnitError(message);
        throw error;
      }

      const kind = this.provider.classifyError(error);
      this.circuit.recordFailure(kind);

      if (kind === "quota_exhausted") {
        log.error(
          { unitId: unit.id, error: message },
          "AI provider refused service (spend or usage limit); pipeline paused",
        );

        throw new ProviderPausedError(message);
      }

      if (kind === "unauthorized") {
        log.error(
          { unitId: unit.id, error: message },
          "AI provider refused the credential; pipeline paused",
        );

        throw new ProviderUnauthorizedError(message);
      }

      if (kind === "permanent") throw new PermanentUnitError(message);

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
          provider: usage?.provider ?? this.provider.providerName,
          model: usage?.model ?? this.provider.model,
          status,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          durationMs: usage?.durationMs,
          errorMessage,
        },
      })
      .catch((error) => {
        log.error(
          { err: error, unitId, attemptNo },
          "AI provider attempt could not be recorded",
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
    result: OdometerUnitResult | ChecklistUnitResult | ProofSuggestionRecord,
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

  /**
   * Gives one unit back — a checklist field that will never succeed — while
   * the request is still this replica's, so a stale owner never releases a
   * unit the new owner is analysing.
   */
  private async releaseUnit(
    request: ClaimedRequest,
    unit: AIAnalysisUnit,
    reason: string,
  ): Promise<void> {
    await database.$transaction(async (tx) => {
      const owned = await tx.aIAnalysisRequest.count({
        where: this.fenced(request),
      });

      if (owned === 0) throw new LeaseLostError(request.id);

      const released = await tx.aIAnalysisUnit.updateMany({
        where: { id: unit.id, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: new Date(), lastError: reason },
      });

      if (released.count === 1) {
        await releaseReservedUnits(tx, request.periodId, 1);
      }
    });
  }

  // ==========================================================================
  // Record + request state
  // ==========================================================================

  /**
   * Settles the request and gives back whatever it still holds reserved, in
   * one transaction and only while the claim is still this replica's.
   *
   * By id alone, a stale owner — its lease run out, the request re-claimed —
   * wrote its FAILED over the new owner's COMPLETED and released units the
   * new owner was still analysing: a photo paid to the provider and never
   * charged to the quota (GAP2-2). Throws LeaseLostError when fenced out.
   */
  private async finalizeRequest(
    request: ClaimedRequest,
    status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED",
    lastError?: string | null,
  ): Promise<void> {
    const owned = await database.$transaction(async (tx) => {
      const settled = await tx.aIAnalysisRequest.updateMany({
        where: this.fenced(request),
        data: {
          status,
          completedAt: new Date(),
          lastError: lastError ?? null,
        },
      });

      if (settled.count === 0) return false;

      const released = await tx.aIAnalysisUnit.updateMany({
        where: { requestId: request.id, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: new Date() },
      });

      if (released.count > 0) {
        await releaseReservedUnits(tx, request.periodId, released.count);
      }

      return true;
    });

    if (!owned) throw new LeaseLostError(request.id);
  }

  /**
   * The record moved on before anything was read: the photo was replaced,
   * the mileage edited, or the record deleted. Settled without calling the
   * provider and without charging the quota; the newer input has — or had —
   * its own request.
   *
   * SKIPPED keeps a fuel or checklist input revivable: an edit reverted to
   * the same photo and value hashes to this request again, and must be read.
   * A receipt passes COMPLETED (see processProofRequest).
   */
  private async settleSuperseded(
    request: ClaimedRequest,
    status: "SKIPPED" | "COMPLETED" = "SKIPPED",
  ): Promise<void> {
    await this.finalizeRequest(
      request,
      status,
      `${INPUT_SUPERSEDED_MARKER}: o registro não tem mais a foto ou o valor que este pedido ia ler.`,
    );

    log.info(
      { requestId: request.id, recordId: request.recordId, type: request.type },
      "AI analysis skipped: its input is no longer the record's",
    );
  }

  /**
   * Back to the queue, due now, with the attempt given back: the provider
   * refused service to everybody, and the request did nothing to deserve a
   * step toward FAILED. The circuit keeps anyone from claiming it until the
   * probe (AI-8).
   */
  private async pauseRequest(
    request: ClaimedRequest,
    reason: string | null,
  ): Promise<void> {
    const paused = await database.aIAnalysisRequest.updateMany({
      where: this.fenced(request),
      data: {
        status: "PENDING",
        attempts: { decrement: 1 },
        availableAt: new Date(),
        leaseExpiresAt: null,
        lastError: `${PROVIDER_PAUSED_MARKER}: ${reason ?? "provedor indisponível"}`,
      },
    });

    if (paused.count === 0) throw new LeaseLostError(request.id);
  }

  /**
   * The reader's queue was full: back to the queue in 5–15 s with the
   * attempt given back. `lastError` is left as it was — busy is not an error
   * the record should show, and units already read keep their results.
   */
  private async deferBusyRequest(request: ClaimedRequest): Promise<void> {
    const deferred = await database.aIAnalysisRequest.updateMany({
      where: this.fenced(request),
      data: {
        status: "PENDING",
        attempts: { decrement: 1 },
        availableAt: new Date(Date.now() + busyRetryDelayMs()),
        leaseExpiresAt: null,
      },
    });

    if (deferred.count === 0) throw new LeaseLostError(request.id);
  }

  /**
   * A fuel or proof unit the reader does not cover: settled without a call,
   * its reservation given back by the fenced finalize (no quota spent).
   */
  private async settleUnsupported(
    request: ClaimedRequest,
    status: "SKIPPED" | "COMPLETED",
  ): Promise<void> {
    await this.finalizeRequest(request, status, UNSUPPORTED_BY_READER_MARKER);

    log.info(
      { requestId: request.id, type: request.type },
      "AI analysis given back: the configured reader does not read this kind",
    );
  }

  private async recordRequestFailure(
    request: ClaimedRequest,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ProviderBusyError) {
      await this.deferBusyRequest(request).catch((deferError) => {
        if (deferError instanceof LeaseLostError) return;

        // The lease recovers the row if even this update fails.
        log.error(
          { err: deferError, requestId: request.id },
          "AI analysis could not be deferred after the reader was busy",
        );
      });

      return;
    }

    if (error instanceof ProviderPausedError) {
      await this.pauseRequest(request, message).catch((pauseError) => {
        if (pauseError instanceof LeaseLostError) return;

        // The lease recovers the row if even this update fails.
        log.error(
          { err: pauseError, requestId: request.id },
          "AI analysis could not be put back after the provider refused service",
        );
      });

      return;
    }

    const delay =
      error instanceof NonRetryableRequestError ||
      error instanceof PermanentUnitError ||
      error instanceof ProviderUnauthorizedError
        ? null
        : aiRetryDelayMs(request.attempts);

    const fields = {
      requestId: request.id,
      businessId: request.businessId,
      attempt: request.attempts,
      retryInMs: delay,
      error: message,
    };

    // A retry is a warning; a request settled as failed is an error.
    if (delay !== null) {
      log.warn(fields, "AI analysis attempt failed; retrying");
    } else {
      log.error(fields, "AI analysis failed");
    }

    if (delay !== null) {
      // Fenced: a stale owner must not put back in the queue a request a
      // newer owner is working on, or has already finished.
      await database.aIAnalysisRequest
        .updateMany({
          where: this.fenced(request),
          data: {
            status: "PENDING",
            availableAt: new Date(Date.now() + delay),
            lastError: message,
          },
        })
        .catch((updateError) => {
          // The lease recovers the row if even this update fails.
          log.error(
            { err: updateError, requestId: request.id },
            "AI analysis retry could not be scheduled",
          );
        });

      return;
    }

    // Retries exhausted (or unfixable): give the reservation back, mark the
    // record so the user is not left staring at "analyzing" forever, close.
    try {
      const consumedCount = await database.aIAnalysisUnit.count({
        where: { requestId: request.id, status: "CONSUMED" },
      });

      // Releases the reservation in the same fenced transaction; a stale
      // owner throws LeaseLostError here and touches neither the record nor
      // the user's screen.
      await this.finalizeRequest(
        request,
        consumedCount > 0 ? "PARTIAL" : "FAILED",
        message,
      );

      if (request.type === "FUEL_ODOMETER") {
        // Only while the fuelling still holds this input (AI-4).
        const marked = await markFuelError(
          request.recordId,
          request.input as AIAnalysisInputMap["FUEL_ODOMETER"],
        ).catch(() => false);

        if (marked) {
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
      } else if (request.type === "CHECKLIST") {
        // A checklist whose PROVIDER failed is settled inside
        // processChecklistRequest. One ending here never got that far — the
        // poison guard, retries spent on an infrastructure error — and its
        // record said "analyzing" forever: it gets the same verdict, from the
        // fields analysed so far ("error" when none), and the same event.
        await this.settleFailedChecklist(request).catch((recordError) => {
          log.warn(
            { err: recordError, requestId: request.id },
            "checklist record could not be marked after its analysis failed",
          );
        });
      } else {
        // The card shows "Leitura falhou" from the request's status; the
        // queue's screens are told to refetch it.
        this.emit(request, {
          step: "completed",
          stepNumber: 3,
          totalSteps: 3,
          overallStatus: "error",
        });
      }
    } catch (finalizeError) {
      if (finalizeError instanceof LeaseLostError) {
        log.warn(
          { requestId: request.id, attempt: request.attempts },
          "AI analysis taken over by another replica; its failure is left to the new owner",
        );
        return;
      }

      log.error(
        { err: finalizeError, requestId: request.id },
        "AI analysis could not be settled",
      );
    }
  }

  /** Runs after the fenced finalize: only the owner reaches it. */
  private async settleFailedChecklist(request: ClaimedRequest): Promise<void> {
    const units = await database.aIAnalysisUnit.findMany({
      where: { requestId: request.id },
    });

    const verdict = await this.writeChecklistVerdict(request, units);

    // A checklist whose photos were all replaced meanwhile has a newer
    // request writing it; this one says nothing.
    if (!verdict.written) return;

    // Fields analysed before the failure can still show a contradiction.
    // After the finalize, so at most once — the eventKey dedupes a repeat.
    if (verdict.overallStatus === "issues_found") {
      await this.publishIssueEvent(
        request,
        verdict.overallStatus,
        "Algumas condições informadas não correspondem às fotos.",
      );
    }

    await this.emitChecklistCompleted(
      request,
      units.length + 2,
      verdict.merged,
      verdict.overallStatus,
    );
  }

  // ==========================================================================
  // Websocket events
  // ==========================================================================

  private emit(
    request: ClaimedRequest,
    event: Record<string, unknown>,
  ): void {
    sendAIVerificationEvent(request.requestedById, {
      recordType: aiRecordTypeOf(request.type),
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
      log.error(
        { err: error, requestId: request.id, businessId: request.businessId },
        "AI verification issue alert could not be published",
      );
    }
  }

  /**
   * Tells the driver that the receipt they sent looks wrong, or that its
   * photo could not be read (decision 6.9): push and in-app, through the
   * notification pipeline, once per request. A suggestion, never a verdict:
   * the office still decides, and the message says so. Only for a reading
   * that reached the card — a card a person already decided, or a photo
   * replaced since, is nobody's news.
   */
  private async publishProofFeedback(
    request: ClaimedRequest,
    feedback: ProofDriverFeedback,
    recipientName: string,
  ): Promise<void> {
    try {
      await this.outbox.publishAfterCommit({
        topic: PROOF_FEEDBACK_TOPIC,
        aggregateType: "delivery",
        aggregateId: request.recordId,
        businessId: request.businessId,
        actorId: request.requestedById,
        eventKey: `${PROOF_FEEDBACK_TOPIC}:${request.id}`,
        payload: {
          businessId: request.businessId,
          deliveryId: request.recordId,
          driverUserId: request.requestedById,
          recipientName,
          // Said as the problem, never the positive question: "é um canhoto
          // de entrega" told a driver the opposite of what was wrong.
          problems: feedback.problems,
          summary: feedback.summary,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }

      log.error(
        { err: error, requestId: request.id, businessId: request.businessId },
        "proof feedback to the driver could not be published",
      );
    }
  }
}

/** What the requester's screen is told about a receipt (the app's contract). */
function proofResultPayload(record: ProofSuggestionRecord) {
  const assessment = record.assessment;

  // The same problems the push names, so the screen and the phone agree.
  const feedback = assessment
    ? driverFeedbackFor(record.reading, assessment)
    : null;

  return {
    suggestion: assessment?.suggestion ?? "needs_review",
    failed: assessment?.failed ?? [],
    uncertain: assessment?.uncertain ?? [],
    problems: feedback?.problems ?? describeProblems(assessment?.failed ?? []),
    details: assessment ? describeAssessment(assessment) : "",
  };
}

export {
  AIAnalysisPipelineService,
  AI_BUSY_RETRY_MIN_MS,
  AI_BUSY_RETRY_SPREAD_MS,
  AI_CONCURRENCY,
  PROOF_FEEDBACK_TOPIC,
  busyRetryDelayMs,
};
