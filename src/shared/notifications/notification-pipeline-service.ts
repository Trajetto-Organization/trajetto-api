import { resolve } from "node:path";

import { NotificationChannel, Prisma } from "@prisma/client";
import { container } from "tsyringe";

import database from "@/../infra/database";
import { env } from "@/env";
import { claimFloors } from "@/shared/database/claim-floors";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { sendNotificationToUser } from "@/websocket";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { consumesQueue } from "@/shared/lifecycle/process-role";
import { announceWake } from "@/shared/wake/wake-bus";
import { ContinuousPool } from "@/shared/queue/continuous-pool";
import {
  EXHAUSTED_CLOSE_INTERVAL_MS,
  closeExhaustedInBatches,
  exhaustedCloseSql,
} from "@/shared/queue/exhausted-close";
import {
  columnOf,
  fairClaimSql,
  nextFairCursor,
  type FairQueue,
} from "@/shared/queue/fair-claim";

import { IMailProvider } from "@/shared/providers/mail-provider/IMail-provider";
import { MailDeliveryError } from "@/shared/providers/mail-provider/errors/mail-delivery-error";
import { InvalidMessageTemplateError } from "@/shared/delivery/message-template";
import { readRecipientEmails } from "@/shared/delivery/recipient-email";
import type { IExternalRecipientRepository } from "@/modules/delivery/repositories/IExternal-recipient-repository";
import { SUPPRESSED_ADDRESS_REASON } from "./customer-message-suppression";

import { deliveryIdFor } from "./delivery-id";
import { getNotificationPolicy } from "./notification-policy";
import { sendExpoPushMessages } from "./push-provider";
import { inAppPushData, withPushOwner } from "./push-data";
import {
  WhatsAppTemplateMismatchError,
  prepareInternalWhatsApp,
} from "./whatsapp-templates";
import { recordExpoTickets } from "./provider-receipts";
import {
  formatDeliveryError,
  providerDetailOf,
  recipientGoneError,
  suppressedChannels,
  type ProviderErrorDetail,
} from "./delivery-diagnostics";
import {
  NotificationPolicyEntry,
  NotificationTopic,
  TopicPayloadMap,
  type PolicyDeps,
} from "./notification-types";

import {
  DELIVERY_BATCH_SIZE,
  DELIVERY_LANES,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_DELAYS_MS,
  PER_DELIVERY_TIMEOUT_MS,
  UNKNOWN_TOPIC_PATIENCE_MS,
  UNKNOWN_TOPIC_RECHECK_MS,
  assertDeliveryLeaseInvariant,
  channelsForRecipient,
  honourRetryAfter,
  nextRetryDelayMs,
  recipientsBesidesActor,
  resolveRecipientChannelFlags,
  withRetryJitter,
  type DeliveryLane,
} from "./pipeline-rules";
import {
  assertWithVariable,
  type QueueConcurrencyVariable,
} from "@/shared/lifecycle/queue-config";
import {
  recordAcceptedOutcome,
  recordDeadline,
} from "@/shared/resilience/record-accepted-outcome";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";

/**
 * The interval is a background sweep, not the primary trigger: publishing an
 * event calls `wake()` and gets processed within milliseconds. The sweep only
 * exists for what a wake can't cover — scheduled retries, leases orphaned by
 * a dead replica, and events published by another replica — so it can be
 * slow, keeping idle instances (and dev query logs) quiet. A dedicated worker
 * (PROCESS_ROLE=worker) is woken by nobody in its own process and polls
 * faster: its preset sets 2 s.
 */
const SWEEP_INTERVAL_MS = env.PIPELINE_SWEEP_INTERVAL_MS;

/**
 * The events one outbox claim takes when nothing it claimed still waits
 * (the pool's prefetch, plano-escala F3-06). Each event renews its own
 * lease right before its expansion, so the ones claimed ahead of a slot
 * wait without risk.
 */
const OUTBOX_BATCH_SIZE = 10;

/**
 * Events expanded at the same time (plano-escala F3-05):
 * OUTBOX_EXPANSION_CONCURRENCY, 1 by default — one after the other, as
 * before. Each event renews its own lease right before its expansion, so no
 * lease invariant depends on it; several at once only bring the queue
 * forward, the overlap several replicas already had. Never two events of
 * one aggregate at once in a process (the pool's perKey): the order the
 * facts happened in is the order their notices are written in.
 */
const OUTBOX_EXPANSION_CONCURRENCY = env.OUTBOX_EXPANSION_CONCURRENCY;

/**
 * The outbox's claim: the oldest due events, PENDING ones and PROCESSING
 * ones whose lease ran out, under a lease of their own. `floor` is the
 * partitioned queue's claim floor (queue-claim-floor.ts, plano-escala
 * F5-13), or nothing: on the claim and on the UPDATE, so both prune the
 * days that hold nothing in flight. Exported for the plan tests, which
 * measure this very statement.
 */
function outboxClaimSql(
  floor: Prisma.Sql,
  limit: number = OUTBOX_BATCH_SIZE,
): Prisma.Sql {
  return Prisma.sql`
      UPDATE "domain_outbox_event" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "domain_outbox_event"
        WHERE (("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now()
               AND "attempts" < ${OUTBOX_MAX_ATTEMPTS}))${floor}
        ORDER BY "created_at"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )${floor}
      RETURNING "id", "topic", "payload", "businessId", "actorId", "attempts", "created_at", "correlationId",
                "aggregateType", "aggregateId"
    `;
}

/**
 * One delivery lane's claim (claimDeliveries says why it is shaped so),
 * with the claim floor as in outboxClaimSql. availableAt and
 * leaseExpiresAt get the same expression in the same statement, so they
 * are equal: now() does not move within a statement.
 */
function deliveryClaimSql(
  lane: DeliveryLane,
  floor: Prisma.Sql,
  limit: number = DELIVERY_BATCH_SIZE,
): Prisma.Sql {
  // Literals, not parameters: with bound values the planner cannot prove a
  // partial index predicate in a generic plan and falls back to a scan.
  // Safe to inline — the list is DELIVERY_LANES, constants of this module,
  // never input.
  const channels = Prisma.raw(
    DELIVERY_LANES[lane].map((channel) => `'${channel}'`).join(", "),
  );

  return Prisma.sql`
      UPDATE "notification_delivery" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
        "availableAt" = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "notification_delivery"
        WHERE "channel" IN (${channels})
          AND "status" IN ('PENDING', 'PROCESSING')
          AND "availableAt" <= now()
          AND ("status" = 'PENDING'
            OR ("leaseExpiresAt" < now()
                AND "attempts" < ${DELIVERY_MAX_ATTEMPTS}))${floor}
        ORDER BY "availableAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )${floor}
      RETURNING "id", "outboxEventId", "userId", "externalRecipientId", "channel", "attempts"
    `;
}

/**
 * A delivery lane as the fair claim walks it (plano-escala F3-10;
 * shared/queue/fair-claim.ts): the lane's rows by company, through the
 * index notification_delivery_business_<lane>_idx (business_id,
 * availableAt) with the lane's claim predicate (F3-09), and the same SET,
 * due rule and RETURNING as deliveryClaimSql.
 */
function laneFairQueue(lane: DeliveryLane): FairQueue {
  // Literals, as in deliveryClaimSql: the partial index is proved from them.
  const channels = Prisma.raw(
    DELIVERY_LANES[lane].map((channel) => `'${channel}'`).join(", "),
  );

  return {
    table: "notification_delivery",
    tenant: "business_id",
    dueAt: "availableAt",
    indexed: (alias) =>
      Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING') AND ${columnOf(alias, "channel")} IN (${channels})`,
    due: (alias) =>
      Prisma.sql`${columnOf(alias, "availableAt")} <= now() AND (${columnOf(alias, "status")} = 'PENDING' OR (${columnOf(alias, "leaseExpiresAt")} < now() AND ${columnOf(alias, "attempts")} < ${DELIVERY_MAX_ATTEMPTS}::int))`,
    set: Prisma.sql`
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
        "availableAt" = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
        "attempts" = "attempts" + 1`,
    returning: `"id", "outboxEventId", "userId", "externalRecipientId", "channel", "attempts"`,
  };
}

/**
 * One delivery lane's fair claim, company by company from `cursor` (see
 * claimDeliveries). Exported for the plan tests, which measure this very
 * statement.
 */
function deliveryFairClaimSql(
  lane: DeliveryLane,
  input: {
    cursor: string;
    limit: number;
    rowsPerTenant: number;
    maxTenants: number;
    floor: Prisma.Sql;
    rowFloor: Prisma.Sql;
  },
): Prisma.Sql {
  return fairClaimSql(laneFairQueue(lane), input);
}

/**
 * How long shutdown() waits, at most, for the rows in flight. The shutdown
 * plan's workers deadline can only shorten it (shared/lifecycle/
 * shutdown-plan.ts).
 */
const PIPELINE_SHUTDOWN_WAIT_MS = 10_000;

/** Entries of the "channels suppressed" debug line; the total is logged too. */
const SUPPRESSED_LOG_LIMIT = 50;

/**
 * Structured lines, one per delivery outcome, each carrying the ids that
 * find it: delivery, event, the request that caused it (`correlationId`),
 * topic, tenant, channel, attempt (OBS-06).
 */
const log = logger.child({ component: "notification-pipeline" });

/**
 * Deliveries in flight per lane (plano-escala F3-05), each lane with its
 * variable: 5 and 5 by default, the DELIVERY_CONCURRENCY of before. A
 * worker-external that only waits on the providers can take more e-mail at
 * once without the bell's lane following it.
 */
const LANE_CONCURRENCY_VARIABLE: Record<
  DeliveryLane,
  QueueConcurrencyVariable
> = {
  internal: "NOTIFICATION_INTERNAL_CONCURRENCY",
  external: "NOTIFICATION_EXTERNAL_CONCURRENCY",
};

const LANE_CONCURRENCY: Record<DeliveryLane, number> = {
  internal: env.NOTIFICATION_INTERNAL_CONCURRENCY,
  external: env.NOTIFICATION_EXTERNAL_CONCURRENCY,
};

// Fails at import time if batch/concurrency/timeout ever outgrow the lease,
// now with each lane's value from the environment: the boot stops on a
// concurrency too low for the batch. Silently breaking this invariant means
// a second replica reclaiming rows that are still being sent - a duplicate
// WhatsApp, not a slow one.
//
// The lanes run as a continuous pool since F3-06 and claim only for a free
// slot, so a row's worst case is one timeout, well inside this bound: the
// check is kept as the barrier's, which the pool can only beat, because the
// image of before reads the same Environment during a rolling deploy and
// after a rollback, and refuses a value below it.
for (const lane of Object.keys(LANE_CONCURRENCY) as DeliveryLane[]) {
  assertWithVariable(
    LANE_CONCURRENCY_VARIABLE[lane],
    LANE_CONCURRENCY[lane],
    () =>
      assertDeliveryLeaseInvariant(DELIVERY_BATCH_SIZE, LANE_CONCURRENCY[lane]),
  );
}

/**
 * A user's channels that leave the product: the ones a policy's
 * `supersededReason` stops once the fact went stale. The in-app row stays —
 * the inbox is the record of what was asked, and it rings nobody's phone.
 */
const OUT_OF_PRODUCT_CHANNELS: ReadonlySet<NotificationChannel> = new Set([
  NotificationChannel.EMAIL,
  NotificationChannel.WHATSAPP,
  NotificationChannel.PUSH,
]);

/** The e-mail body the pipeline renders for every channel EMAIL delivery. */
const NOTIFICATION_TEMPLATE_MODULE = "notification";
const NOTIFICATION_TEMPLATE_FILE = "notification.hbs";

type AnyPolicy = NotificationPolicyEntry<TopicPayloadMap[NotificationTopic]>;
type AnyPayload = TopicPayloadMap[NotificationTopic];

interface ClaimedEvent {
  id: string;
  topic: string;
  payload: unknown;
  businessId: string | null;
  actorId: string | null;
  attempts: number;
  created_at: Date;
  correlationId: string | null;

  /** The fact's aggregate: one of its events expands at a time (perKey). */
  aggregateType?: string;
  aggregateId?: string;
}

/**
 * The outbox pool's key: the event's aggregate, or the event itself when the
 * claim did not say (a row of a test double).
 */
function aggregateKeyOf(event: ClaimedEvent): string {
  return event.aggregateType && event.aggregateId
    ? `${event.aggregateType}:${event.aggregateId}`
    : `event:${event.id}`;
}

/**
 * The user lookups of one claim's rows, keyed by user id.
 *
 * One event fans out to the same person across in-app, e-mail, WhatsApp and
 * push - four deliveries that used to cost four multi-join user queries.
 * Promises are cached, not values, so concurrent workers share one in-flight
 * lookup instead of racing three more. One map per claim, carried by the
 * claim's rows: the two lanes run at the same time and must not share one.
 */
type RecipientCache = Map<string, Promise<RecipientUser>>;

interface ClaimedDelivery {
  id: string;
  outboxEventId: string;

  /** Exactly one of these is set — the CHECK constraint says so. */
  userId: string | null;
  externalRecipientId: string | null;

  channel: NotificationChannel;

  /**
   * The count AFTER this claim. It doubles as the fencing token: every write
   * that settles the row requires it to still be the one this worker claimed.
   */
  attempts: number;

  recipientCache?: RecipientCache;

  /** Its event, set with the claim: what it renders and is logged by. */
  event?: ClaimedEventRow;

  /**
   * Local clock taken BEFORE the claim statement: the lease the database
   * granted ends no earlier than this plus DELIVERY_LEASE_SECONDS.
   */
  claimStartedAtMs?: number;
}

/** The slice of an outbox row a delivery needs to render itself. */
interface ClaimedEventRow {
  topic: string;
  payload: unknown;
  businessId: string | null;
  created_at: Date;
  correlationId?: string | null;
}

/**
 * What `findUserById` gives the channels. Kept structural (instead of the
 * Prisma model) so the cache does not pin this file to the shape of the
 * user repository.
 */
type RecipientUser = NonNullable<
  Awaited<ReturnType<IUserRepository["findUserById"]>>
>;

/**
 * A failure that retrying can never fix (recipient deleted, no policy). A
 * provider's refusal carries its codes in `detail`, which recordDeliveryFailure
 * writes into lastError (OBS-08).
 */
class NonRetryableDeliveryError extends Error {
  constructor(
    message: string,
    readonly detail?: ProviderErrorDetail,
  ) {
    super(message);
  }
}

/**
 * Whoever the row addressed was deleted (plano-escala F5-05, D54): closed
 * FAILED as `recipient_gone`, before any provider is called. The cascade
 * of today never leaves such a row; without the foreign keys (F5-06) one
 * written while the deletion ran can outlive it.
 */
class RecipientGoneError extends NonRetryableDeliveryError {
  constructor(what: string) {
    super(recipientGoneError(what));
  }
}

/** A failure worth another attempt, when the provider said how long to wait. */
class RetryableDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    readonly detail?: ProviderErrorDetail,
  ) {
    super(message);
  }
}

/**
 * Not this build's to handle: a topic or channel it does not know yet. The row
 * goes back untouched — no attempt spent — for a newer replica to take.
 */
class DeferredDeliveryError extends Error {}

/**
 * The pipeline stopped WAITING on a send; the send itself is still in flight
 * and may yet be accepted. Not an outcome of the delivery — see
 * `runOneDelivery` for what happens instead of a retry.
 */
class DeliveryBackstopTimeoutError extends Error {}

/**
 * Consumes the transactional outbox and executes notification deliveries.
 *
 * Runs inside every API replica. Coordination is entirely in Postgres: each
 * claim is an UPDATE over a `FOR UPDATE SKIP LOCKED` subselect that also
 * takes over rows whose lease expired — so a row is held by one replica while
 * its lease lasts, and a replica dying mid-batch only delays its rows by one
 * lease. A worker that outlives its lease can still be running when another
 * replica reclaims the row: every settling write is fenced by the claim (see
 * `fenced()`), so its late writes change nothing, but its SEND may already
 * have happened. Retries are persisted (`availableAt` + backoff), never held
 * in memory.
 *
 * What it does NOT guarantee, and cannot: a channel that talks to a provider
 * is at-least-once. A replica that dies after the provider accepted a message
 * and before DELIVERED was recorded leaves a row that another replica sends
 * again once the lease expires. E-mail closes that gap at the provider (an
 * idempotency key per delivery); WhatsApp and Expo have no such thing — there
 * the receipts ledger (provider-receipts.ts) makes a second send visible
 * after the fact, which is all that can be had. The Socket.IO emit of an
 * in-app notification is at-most-once; the bell is the truth (ADR 0003).
 */
class NotificationPipelineService {
  private static instance: NotificationPipelineService;

  private outboxTimer: NodeJS.Timeout | null = null;
  private deliveryTimers: NodeJS.Timeout[] = [];

  /** The minute's close of the exhausted rows (closeExhausted, F3-08). */
  private exhaustedTimer: NodeJS.Timeout | null = null;
  private closingExhausted: Promise<number> | null = null;

  private outboxRunning = false;
  private deliveryRunning: Record<DeliveryLane, boolean> = {
    internal: false,
    external: false,
  };

  /**
   * The cycle in flight per queue.
   *
   * A wake, a sweep tick or a test that found a cycle running used to get
   * `return` and nothing else. When it came after that cycle's LAST claim,
   * the work it was announcing waited for the next sweep — 30 s in
   * production — although a cycle was right there; and a test that drove
   * the pipeline by hand checked the provider before the send went out
   * (route-stop-on-the-way, red under load). A caller now joins the cycle in
   * flight and asks its pool to look again (`rescan`): one claim for however
   * many callers arrived, never one per caller, and the cycle does not end
   * before that claim ran.
   */
  private outboxCycle: Promise<boolean> | null = null;
  private deliveryCycles: Record<DeliveryLane, Promise<void> | null> = {
    internal: null,
    external: null,
  };

  /**
   * Where each lane's next fair claim starts (plano-escala F3-10): the last
   * company the previous one visited. This process's own; another process
   * keeps its own, and both rotate.
   */
  private fairCursors: Record<DeliveryLane, string> = {
    internal: "",
    external: "",
  };

  /**
   * Set when the replica starts going away. The pools stop claiming and
   * hand back what they claimed and did not start, and `wake()` stops
   * starting new cycles: shutdown used to only clear the timers, while a
   * draining loop kept claiming batch after batch until the process exited
   * under it — with rows still in flight.
   */
  private stopping = false;

  /**
   * The outbox as a continuous pool (plano-escala F3-06): a batch claimed
   * when nothing claimed still waits, OUTBOX_EXPANSION_CONCURRENCY events
   * expanding, one per aggregate, and the next claim as soon as a slot
   * frees instead of after the batch's slowest expansion.
   */
  private readonly outboxPool = new ContinuousPool<ClaimedEvent>({
    slots: () => OUTBOX_EXPANSION_CONCURRENCY,
    prefetch: OUTBOX_BATCH_SIZE,
    perKey: { limit: 1, keyOf: aggregateKeyOf },
    claim: (limit) => this.claimEvents(limit),
    run: (event) => this.expandClaimedEvent(event),
    giveBack: (event) => this.giveBackEvent(event),
    stopping: () => this.stopping,
    onClaim: () => workerHeartbeat.progress("notification-outbox"),
  });

  /**
   * Each delivery lane as a continuous pool (plano-escala F3-06). A row is
   * claimed only for a free slot (no prefetch): its lease runs from the
   * claim, and a row claimed ahead would wait with it running. One slow
   * e-mail now holds its own slot; the barrier of before held the four that
   * had already finished until it ended.
   */
  private readonly lanePools: Record<
    DeliveryLane,
    ContinuousPool<ClaimedDelivery>
  > = {
    internal: this.lanePool("internal"),
    external: this.lanePool("external"),
  };

  /**
   * Success records still retrying after the batch moved on (the database
   * was away when the provider accepted). Shutdown waits for them.
   */
  private readonly pendingRecords = new Set<Promise<void>>();

  private constructor() {}

  public static getInstance(): NotificationPipelineService {
    if (!NotificationPipelineService.instance) {
      NotificationPipelineService.instance = new NotificationPipelineService();
    }

    return NotificationPipelineService.instance;
  }

  public async initialize(): Promise<void> {
    this.stopping = false;

    // A timer per queue this process claims (WORKER_QUEUES, plano-escala
    // F3-01): a worker-external sweeps the external lane and nothing else,
    // and the outbox it does not claim is expanded by another process.
    if (consumesQueue(env, "outbox")) {
      this.outboxTimer = setInterval(() => {
        // The sweep that expanded events chains into the lanes, as a wake
        // does (plano-escala F3-04): the deliveries it just wrote do not
        // wait for the lanes' own sweep.
        this.runOutboxCycle()
          .then((processed) => (processed ? this.chainLanes() : undefined))
          .catch((error) => {
            log.error({ err: error }, "outbox cycle failed");
          });
      }, SWEEP_INTERVAL_MS);
    }

    for (const lane of this.consumedLanes()) {
      this.deliveryTimers.push(
        setInterval(() => {
          this.runDeliveryCycle(lane).catch((error) => {
            log.error({ err: error, lane }, "delivery cycle failed");
          });
        }, SWEEP_INTERVAL_MS),
      );
    }

    // The exhausted rows of the queues this process claims, closed off the
    // claims' path (plano-escala F3-08): once now, so a replica that comes
    // back after a crash closes what the crash left, then every minute.
    if (this.outboxTimer !== null || this.deliveryTimers.length > 0) {
      const sweep = () => {
        this.closeExhausted().catch((error) => {
          log.error({ err: error }, "exhausted rows close failed");
        });
      };

      this.exhaustedTimer = setInterval(sweep, EXHAUSTED_CLOSE_INTERVAL_MS);
      sweep();
    }

    // No drain here. What accumulated while the API was down is drained by
    // the boot once Socket.IO is up (shared/lifecycle/startup.ts): drained
    // now, every in-app row in the backlog reached the bell with no toast,
    // because `io` did not exist yet (OUTBOX-19).

    log.info(
      { outbox: this.outboxTimer !== null, lanes: this.consumedLanes() },
      "notification pipeline started",
    );
  }

  /** The delivery lanes this process claims, in their fixed order. */
  private consumedLanes(): DeliveryLane[] {
    return (Object.keys(DELIVERY_LANES) as DeliveryLane[]).filter((lane) =>
      consumesQueue(env, lane),
    );
  }

  /**
   * After an outbox pass that expanded events: the lanes this process
   * claims run now, and the ones it does not are announced to the
   * processes that claim them (a worker without `external` wakes the
   * worker-external, F3-04).
   */
  private async chainLanes(): Promise<void> {
    for (const lane of Object.keys(DELIVERY_LANES) as DeliveryLane[]) {
      if (!consumesQueue(env, lane)) announceWake(lane);
    }

    await Promise.all(
      this.consumedLanes().map((lane) => this.runDeliveryCycle(lane)),
    );
  }

  /**
   * One lane, now: what another process's hint asks for (wake-listener.ts,
   * F3-04). Safe at any time, like wake().
   */
  public wakeLane(lane: DeliveryLane): void {
    if (this.stopping || !consumesQueue(env, lane)) return;

    withoutRequestContext(() => {
      this.runDeliveryCycle(lane).catch((error) => {
        log.error({ err: error, lane }, "lane wake failed");
      });
    });
  }

  /**
   * Processes pending work now instead of waiting for the sweep. Called right
   * after an outbox publish commits; expansion chains into both delivery
   * lanes, so a freshly created fine notifies within milliseconds. Safe to
   * call at any time — a cycle already running is joined and runs once more
   * (see `outboxCycle`), and every pass is idempotent.
   *
   * Outside the request that published: `wake` is scheduled from inside a
   * request, and the timer inherits its AsyncLocalStorage — the pipeline then
   * read users through that request's memoised cache for as long as the
   * drain lasted.
   */
  public wake(): void {
    if (this.stopping) return;

    // Only the queues this process claims (WORKER_QUEUES, plano-escala
    // F3-01). On an HTTP-only replica (WORKERS_ENABLED=false) a publish
    // drains nothing: the worker service's sweep picks the event up
    // (GAP2-3).
    const outbox = consumesQueue(env, "outbox");
    const lanes = this.consumedLanes();

    if (!outbox && lanes.length === 0) return;

    withoutRequestContext(() => {
      (outbox ? this.runOutboxCycle() : Promise.resolve(false))
        .then((processed) => {
          // The lanes another process claims hear about the deliveries
          // this pass wrote (F3-04).
          if (processed) {
            for (const lane of Object.keys(DELIVERY_LANES) as DeliveryLane[]) {
              if (!consumesQueue(env, lane)) announceWake(lane);
            }
          }

          return Promise.all(lanes.map((lane) => this.runDeliveryCycle(lane)));
        })
        .catch((error) => {
          log.error({ err: error }, "pipeline wake failed");
        });
    });
  }

  /**
   * `deadlineMs` is the shutdown plan's (shared/lifecycle/shutdown-plan.ts):
   * it can only shorten the pipeline's own 10 s, so a short stop grace is
   * not outlived here.
   */
  public async shutdown(options: { deadlineMs?: number } = {}): Promise<void> {
    this.stopping = true;

    if (this.outboxTimer) clearInterval(this.outboxTimer);
    for (const timer of this.deliveryTimers) clearInterval(timer);
    if (this.exhaustedTimer) clearInterval(this.exhaustedTimer);

    this.outboxTimer = null;
    this.deliveryTimers = [];
    this.exhaustedTimer = null;

    // The pools waiting on a slow row look now: what they claimed and did
    // not start goes back at once, instead of waiting out its lease.
    this.outboxPool.nudge();
    for (const pool of Object.values(this.lanePools)) pool.nudge();

    // Let the rows in flight finish; the pools claim nothing new. Leases
    // cover anything cut off by the deadline.
    const deadline =
      Date.now() +
      Math.min(PIPELINE_SHUTDOWN_WAIT_MS, options.deadlineMs ?? Infinity);

    while (
      (this.isBusy() || this.pendingRecords.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    log.info("notification pipeline stopped");
  }

  /**
   * Closes FAILED, with the reason, the rows of the queues this process
   * claims whose last allowed attempt died with their process: PROCESSING,
   * lease run out, attempts at the ceiling (see shared/queue/
   * exhausted-close.ts). Every minute and at boot; public so a test can run
   * it. A run that finds one in progress joins it.
   */
  public closeExhausted(): Promise<number> {
    this.closingExhausted ??= this.closeExhaustedNow().finally(() => {
      this.closingExhausted = null;
    });

    return this.closingExhausted;
  }

  private async closeExhaustedNow(): Promise<number> {
    let closed = 0;

    if (consumesQueue(env, "outbox")) {
      const floor = await claimFloors.predicate("outbox");
      const events = await closeExhaustedInBatches(() =>
        database.$executeRaw(
          exhaustedCloseSql({
            table: "domain_outbox_event",
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            floor,
          }),
        ),
      );

      if (events > 0) {
        log.warn(
          { queue: "outbox", closed: events },
          "notification events closed: their last allowed attempt died with the process",
        );
      }

      closed += events;
    }

    const channels = this.consumedLanes().flatMap(
      (lane) => DELIVERY_LANES[lane],
    );

    if (channels.length > 0) {
      const floor = await claimFloors.predicate("deliveries");
      const deliveries = await closeExhaustedInBatches(() =>
        database.$executeRaw(
          exhaustedCloseSql({
            table: "notification_delivery",
            maxAttempts: DELIVERY_MAX_ATTEMPTS,
            floor,
            channels,
          }),
        ),
      );

      if (deliveries > 0) {
        log.warn(
          { queue: "deliveries", channels, closed: deliveries },
          "notification deliveries closed: their last allowed attempt died with the process",
        );
      }

      closed += deliveries;
    }

    return closed;
  }

  private isBusy(): boolean {
    return (
      this.outboxRunning ||
      this.deliveryRunning.internal ||
      this.deliveryRunning.external
    );
  }

  // ==========================================================================
  // Outbox: event → deliveries
  // ==========================================================================

  /**
   * Public so a test can drive one cycle against a real database.
   *
   * Resolves once everything due when it was called has been through a
   * claim: a call that finds a cycle running joins it, and that cycle runs
   * one more pass after the current one (see `outboxCycle`). Never rejects
   * for a caller that joined — the cycle's starter reports its failure.
   */
  public runOutboxCycle(): Promise<boolean> {
    if (this.outboxCycle) {
      this.outboxPool.rescan();

      return this.outboxCycle.catch(() => false);
    }

    this.outboxRunning = true;

    // Assigned before the loop can end: the loop awaits its first pass before
    // its `finally` clears the field, so the clearing always comes after this.
    const cycle = this.runOutboxPasses();
    this.outboxCycle = cycle;

    return cycle;
  }

  private async runOutboxPasses(): Promise<boolean> {
    let processedAny = false;

    try {
      for (;;) {
        processedAny = (await this.drainOutbox()) || processedAny;

        // A look asked for between the pool's last one and its end.
        if (!this.outboxPool.rescanPending || this.stopping) break;
      }
    } finally {
      // Same synchronous turn as the last look at `rescanPending`: a caller
      // either saw this cycle and was covered by the claim it asked for, or
      // finds it gone and starts the next one.
      this.outboxCycle = null;
      this.outboxRunning = false;
    }

    return processedAny;
  }

  /** One cycle of the outbox's pool: until nothing is due nor in flight. */
  private async drainOutbox(): Promise<boolean> {
    // A hung await here keeps the flag set forever; the beats make that
    // visible on /health/metrics (OBS-10).
    workerHeartbeat.beginCycle("notification-outbox");

    try {
      return (await this.outboxPool.drain()) > 0;
    } finally {
      workerHeartbeat.endCycle("notification-outbox");
    }
  }

  /** One claimed event, start to settle. Never rejects: the pool goes on. */
  private async expandClaimedEvent(event: ClaimedEvent): Promise<void> {
    try {
      // A claim's lease covers the events it took ahead of a slot, and they
      // wait for one. Under a saturated pool the last ones used to start
      // after the lease ran out, when another replica had already reclaimed
      // them — and both expanded them (OUTBOX-21).
      if (!(await this.renewEventLease(event))) {
        log.warn(
          {
            outboxEventId: event.id,
            correlationId: event.correlationId ?? null,
            topic: event.topic,
            attempt: event.attempts,
          },
          "notification event reclaimed by another replica before its expansion; left to it",
        );

        return;
      }

      await this.expandEvent(event);
    } catch (error) {
      await this.recordEventFailure(event, error);
    }
  }

  /**
   * An event claimed and never started, handed back on shutdown: the claim
   * was not an attempt. Fenced like every settling write, and due now, so
   * the next replica takes it without waiting out the lease.
   */
  private async giveBackEvent(event: ClaimedEvent): Promise<void> {
    await database.domainOutboxEvent.updateMany({
      where: this.fenced(event),
      data: {
        status: "PENDING",
        attempts: event.attempts - 1,
        availableAt: new Date(),
        leaseExpiresAt: null,
      },
    });
  }

  /**
   * A fresh lease for one event, right before it is expanded, and proof that
   * it is still this worker's. Fenced like every settling write: an event
   * another replica reclaimed has moved `attempts` on, the update matches
   * nothing, and this worker leaves it to its new owner instead of expanding
   * it a second time. The database clock, like the claim.
   */
  private async renewEventLease(event: ClaimedEvent): Promise<boolean> {
    const renewed = await database.$executeRaw`
      UPDATE "domain_outbox_event" SET
        "leaseExpiresAt" = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS})
      WHERE "id" = ${event.id}
        AND "status" = 'PROCESSING'
        AND "attempts" = ${event.attempts}
    `;

    return renewed === 1;
  }

  private async claimEvents(
    limit: number = OUTBOX_BATCH_SIZE,
  ): Promise<ClaimedEvent[]> {
    const floor = await claimFloors.predicate("outbox");

    // A row whose last allowed attempt died with the process is left out
    // (attempts < OUTBOX_MAX_ATTEMPTS) and closed by the minute's sweep
    // (closeExhausted, plano-escala F3-08), not here: the claim is one
    // statement, whatever is queued.
    return database.$queryRaw<ClaimedEvent[]>(outboxClaimSql(floor, limit));
  }

  /**
   * The row as this worker claimed it. Every write that settles an event or a
   * delivery is conditioned on this: if the lease ran out and another replica
   * claimed the row, `attempts` moved on, the write matches nothing, and the
   * late worker can no longer overwrite what the new owner decided — a
   * DELIVERED turned back into PENDING was a third copy of the message.
   */
  private fenced(row: { id: string; attempts: number }) {
    return {
      id: row.id,
      status: "PROCESSING" as const,
      attempts: row.attempts,
    };
  }

  /**
   * The one write that settles a delivery — success, retry, failure or
   * deferral — always fenced to the claim this worker holds.
   */
  private settleDelivery(
    delivery: ClaimedDelivery,
    data: Prisma.NotificationDeliveryUpdateManyMutationInput,
  ): Promise<Prisma.BatchPayload> {
    return database.notificationDelivery.updateMany({
      where: this.fenced(delivery),
      data,
    });
  }

  private async expandEvent(event: ClaimedEvent): Promise<void> {
    const policy = getNotificationPolicy(event.topic);

    if (!policy) {
      await this.deferOrFailEvent(
        event,
        `No notification policy registered for topic "${event.topic}"`,
      );

      return;
    }

    const payload = event.payload as AnyPayload;

    const userRepository = container.resolve<IUserRepository>("UserRepository");

    const policyDeps = {
      userRepository,

      externalRecipientRepository: container.resolve(
        "ExternalRecipientRepository",
      ),
      messageTemplateRepository: container.resolve(
        "DeliveryMessageTemplateRepository",
      ),
      businessRepository: container.resolve("BusinessRepository"),
      occurrenceAuthorizationRepository: container.resolve(
        "OccurrenceAuthorizationRepository",
      ),
    };

    const resolved = await policy.resolveRecipients(payload, policyDeps);

    // Nobody is notified of what they just did, on any channel; the topics
    // that still tell them say why in `notifiesActor` (pipeline-rules.ts).
    const recipients = recipientsBesidesActor(
      resolved,
      event.actorId,
      policy.notifiesActor,
    );

    const actorLeftOut = recipients.length < resolved.length;

    // People with no account. Absent on every internal topic, which is why
    // the hook is optional and nothing else in this method changed.
    const externals = policy.resolveExternalRecipients
      ? await policy.resolveExternalRecipients(payload, policyDeps)
      : [];

    // Per-category choices, fetched in one query for the whole batch. A user
    // without a row falls back to their legacy global toggles.
    const preferences = recipients.length
      ? await database.notificationPreference.findMany({
          where: {
            category: policy.category,
            userId: { in: recipients.map((recipient) => recipient.id) },
          },
        })
      : [];

    const preferenceByUser = new Map(
      preferences.map((preference) => [preference.userId, preference]),
    );

    // Who has a registered mobile device — a PUSH delivery only exists for
    // them, so web-only users never accumulate dead push rows.
    const pushOwners = recipients.length
      ? new Set(
          (
            await database.pushDeviceToken.findMany({
              where: {
                userId: { in: recipients.map((recipient) => recipient.id) },
              },
              select: { userId: true },
            })
          ).map((row) => row.userId),
        )
      : new Set<string>();

    const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];

    // What was left out and why (OBS-08): no row is created for a suppressed
    // channel, so without this "she never gets WhatsApp" had nothing to show.
    const suppressed: Array<{
      userId?: string;
      externalRecipientId?: string;
      channel: NotificationChannel;
      reason: string;
    }> = [];

    for (const recipient of recipients) {
      const flags = resolveRecipientChannelFlags(
        recipient,
        preferenceByUser.get(recipient.id),
      );

      const options = {
        hasInAppContent: Boolean(policy.renderInApp),
        hasEmailContent: Boolean(policy.renderInApp) && !policy.suppressEmail,
        // Asked of the render itself, per recipient (B1): a topic whose
        // WhatsApp exists for one audience and not another (the automatic
        // card of a service order) creates no row it could never send.
        hasWhatsAppContent: Boolean(
          policy.renderWhatsApp?.(payload, {
            id: recipient.id,
            role: recipient.role,
            driverId: recipient.driverId,
          }),
        ),
        isMandatory: Boolean(policy.mandatory),
        hasPushDevice: pushOwners.has(recipient.id),
        hasStandalonePushContent: Boolean(policy.renderPush),
      };

      const channels = channelsForRecipient(flags, options);

      for (const channel of channels) {
        rows.push({ outboxEventId: event.id, userId: recipient.id, channel });
      }

      for (const left of suppressedChannels(flags, options)) {
        suppressed.push({ userId: recipient.id, ...left });
      }
    }

    for (const external of externals) {
      // Somebody who asked to stop hearing from us. Checked here rather than
      // at send time so no row is even created — a queued message that is
      // then skipped is a message that shows as failed in every report.
      if (external.opted_out_at) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.EMAIL,
          reason: "opted_out",
        });
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.WHATSAPP,
          reason: "opted_out",
        });

        continue;
      }

      // The same person opted out from another delivery of this company
      // (D38): their phone or e-mail is suppressed for every one of them.
      const blocked = await this.suppressedChannelsOf(
        event.businessId,
        external,
      );

      // Only the valid addresses are written to (recipient-email.ts): a value
      // stored before the imports checked it may hold none.
      const hasEmail = readRecipientEmails(external.email).addresses.length > 0;

      if (!external.email) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.EMAIL,
          reason: "no_contact",
        });
      } else if (!hasEmail) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.EMAIL,
          reason: "invalid_address",
        });
      } else if (blocked.has("EMAIL")) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.EMAIL,
          reason: "suppressed_address",
        });
      }

      if (!external.telephone) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.WHATSAPP,
          reason: "no_contact",
        });
      } else if (blocked.has("WHATSAPP")) {
        suppressed.push({
          externalRecipientId: external.id,
          channel: NotificationChannel.WHATSAPP,
          reason: "suppressed_address",
        });
      }

      // The channels follow the contact details we actually hold. No in-app,
      // no push: there is no app and no inbox. No preferences either — an
      // outsider never had a row to express one, and the way they say stop is
      // the opt-out link in the message itself.
      if (hasEmail && !blocked.has("EMAIL")) {
        rows.push({
          outboxEventId: event.id,
          externalRecipientId: external.id,
          channel: NotificationChannel.EMAIL,
        });
      }

      if (external.telephone && !blocked.has("WHATSAPP")) {
        rows.push({
          outboxEventId: event.id,
          externalRecipientId: external.id,
          channel: NotificationChannel.WHATSAPP,
        });
      }
    }

    // The activity trail entry is one delivery for the actor, so it rides the
    // same idempotency: the old flow created it once per recipient, stamping
    // duplicate activities whenever more than one admin was notified.
    if (policy.renderActivity && event.actorId) {
      rows.push({
        outboxEventId: event.id,
        userId: event.actorId,
        channel: NotificationChannel.ACTIVITY,
      });
    }

    // skipDuplicates makes a re-run after a crash, or by a replica that took
    // the event over, a no-op instead of a second batch of notifications:
    // every row's id is decided by its event, recipient and channel
    // (delivery-id.ts, plano-escala F5-03), so a second expansion computes
    // the same primary keys. The (event, recipient, channel) unique indexes
    // still say the same until wave 10 drops them (F5-06), and keep the rows
    // the previous image wrote under random ids, during the rolling deploy,
    // from gaining a twin. The PUBLISHED mark is fenced: if this worker lost
    // the row to another replica the rows above were a no-op and so is the
    // mark.
    await database.$transaction([
      database.notificationDelivery.createMany({
        // Every row carries the event's company (plano-escala F3-09): the
        // fair claim of the lanes takes them company by company. NULL for
        // the platform's own events, the claim's "no company" bucket.
        data: rows.map((row) => ({
          ...row,
          id: deliveryIdFor(event, row, row.channel),
          business_id: event.businessId,
        })),
        skipDuplicates: true,
      }),
      database.domainOutboxEvent.updateMany({
        where: this.fenced(event),
        data: {
          status: "PUBLISHED",
          processedAt: new Date(),
          leaseExpiresAt: null,
          lastError: null,
        },
      }),
    ]);

    // Debug, not info: a web-only user has no push device on every event.
    // LOG_LEVEL=debug answers "why did she never get it?" (OBS-08), and
    // `actorLeftOut` "why did I not get my own?".
    if (suppressed.length > 0 || actorLeftOut) {
      log.debug(
        {
          outboxEventId: event.id,
          topic: event.topic,
          businessId: event.businessId,
          ...(actorLeftOut && { actorLeftOut: event.actorId }),
          suppressed: suppressed.slice(0, SUPPRESSED_LOG_LIMIT),
          suppressedTotal: suppressed.length,
        },
        "notification channels suppressed",
      );
    }
  }

  /**
   * An event under a topic this build does not know: put back for a build
   * that does, without spending an attempt — unless it has waited a day,
   * which is no longer a deploy in progress.
   */
  private async deferOrFailEvent(
    event: ClaimedEvent,
    reason: string,
  ): Promise<void> {
    const age = Date.now() - new Date(event.created_at).getTime();

    const data =
      age < UNKNOWN_TOPIC_PATIENCE_MS
        ? {
            status: "PENDING" as const,
            attempts: { decrement: 1 },
            availableAt: new Date(Date.now() + UNKNOWN_TOPIC_RECHECK_MS),
            leaseExpiresAt: null,
            lastError: `${reason} (aguardando uma versão que conheça o tópico)`,
          }
        : {
            status: "FAILED" as const,
            leaseExpiresAt: null,
            lastError: reason,
          };

    await database.domainOutboxEvent.updateMany({
      where: this.fenced(event),
      data,
    });
  }

  private async recordEventFailure(
    event: ClaimedEvent,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    const baseDelay = nextRetryDelayMs(event.attempts, OUTBOX_RETRY_DELAYS_MS);
    const delay = baseDelay === null ? null : withRetryJitter(baseDelay);

    const fields = {
      outboxEventId: event.id,
      correlationId: event.correlationId ?? null,
      topic: event.topic,
      businessId: event.businessId,
      attempt: event.attempts,
      willRetry: delay !== null,
      error: message,
    };

    if (delay === null) {
      log.error(fields, "notification event failed");
    } else {
      log.warn(fields, "notification event failed");
    }

    await database.domainOutboxEvent
      .updateMany({
        where: this.fenced(event),
        data:
          delay === null
            ? { status: "FAILED", leaseExpiresAt: null, lastError: message }
            : {
                status: "PENDING",
                availableAt: new Date(Date.now() + delay),
                leaseExpiresAt: null,
                lastError: message,
              },
      })
      .catch((updateError) => {
        // The lease recovers the row if even this update fails.
        log.error(
          { err: updateError, outboxEventId: event.id },
          "notification event failure could not be recorded",
        );
      });
  }

  // ==========================================================================
  // Deliveries: one row = one recipient × one channel, in two lanes
  // ==========================================================================

  /**
   * Public so a test can drive one cycle against a real database.
   *
   * Same contract as `runOutboxCycle`: a call that finds this lane's cycle
   * running joins it and gets a claim of its own before the cycle ends,
   * instead of returning before the rows it was called for were claimed.
   */
  public runDeliveryCycle(lane: DeliveryLane): Promise<void> {
    const inFlight = this.deliveryCycles[lane];

    if (inFlight) {
      this.lanePools[lane].rescan();

      return inFlight.catch(() => undefined);
    }

    this.deliveryRunning[lane] = true;

    // Assigned before the loop can end — see runOutboxCycle.
    const cycle = this.runDeliveryPasses(lane);
    this.deliveryCycles[lane] = cycle;

    return cycle;
  }

  private async runDeliveryPasses(lane: DeliveryLane): Promise<void> {
    try {
      for (;;) {
        await this.drainDeliveries(lane);

        // A look asked for between the pool's last one and its end.
        if (!this.lanePools[lane].rescanPending || this.stopping) break;
      }
    } finally {
      this.deliveryCycles[lane] = null;
      this.deliveryRunning[lane] = false;
    }
  }

  /** A lane's continuous pool (see lanePools). */
  private lanePool(lane: DeliveryLane): ContinuousPool<ClaimedDelivery> {
    return new ContinuousPool<ClaimedDelivery>({
      slots: () => LANE_CONCURRENCY[lane],
      maxPerClaim: DELIVERY_BATCH_SIZE,
      claim: (limit) => this.claimLaneRows(lane, limit),
      run: (delivery) => this.runOneDelivery(delivery),
      giveBack: (delivery) => this.giveBackDelivery(delivery),
      stopping: () => this.stopping,
      onClaim: () => workerHeartbeat.progress(`notification-delivery-${lane}`),
    });
  }

  /** One cycle of a lane's pool: until nothing is due nor in flight. */
  private async drainDeliveries(lane: DeliveryLane): Promise<void> {
    const beatName = `notification-delivery-${lane}`;

    workerHeartbeat.beginCycle(beatName);

    try {
      await this.lanePools[lane].drain();
    } finally {
      workerHeartbeat.endCycle(beatName);
    }
  }

  /**
   * Claims up to `limit` rows of a lane and reads their events in one query,
   * the rows of the claim sharing one recipient cache.
   */
  private async claimLaneRows(
    lane: DeliveryLane,
    limit: number,
  ): Promise<ClaimedDelivery[]> {
    const deliveries = await this.claimDeliveries(lane, limit);

    if (deliveries.length === 0) return deliveries;

    const events = await database.domainOutboxEvent.findMany({
      where: { id: { in: deliveries.map((d) => d.outboxEventId) } },
    });

    const eventsById = new Map(events.map((event) => [event.id, event]));

    const recipientCache: RecipientCache = new Map();

    for (const delivery of deliveries) {
      delivery.recipientCache = recipientCache;
      delivery.event = eventsById.get(delivery.outboxEventId);
    }

    return deliveries;
  }

  /**
   * A row claimed and never started, handed back on shutdown: the claim was
   * not an attempt. Fenced, and due now, so the next replica takes it
   * without waiting out the 180 s lease.
   */
  private async giveBackDelivery(delivery: ClaimedDelivery): Promise<void> {
    await this.settleDelivery(delivery, {
      status: "PENDING",
      attempts: delivery.attempts - 1,
      availableAt: new Date(),
      leaseExpiresAt: null,
    });
  }

  /**
   * One delivery, start to finish, never throwing: a failure here is a row
   * update, not an exception that would abort its sibling workers.
   *
   * SENDING and RECORDING are two steps with two failure paths. A send that
   * failed is retried on the schedule. A send the provider ACCEPTED whose
   * DELIVERED mark then failed is not a failed send — treating it as one put
   * the message on the wire a second time half a minute later.
   *
   * A send that outlived PER_DELIVERY_TIMEOUT_MS is neither. The worker stops
   * waiting for it, but the call is still on the wire and the provider may
   * yet accept it: recording a failure there put the row back in PENDING for
   * ~30s and the retry sent a second copy. The row stays PROCESSING under
   * this claim's lease instead, and the outcome is recorded when the call
   * settles — through the same fenced writes, so if the lease ran out first
   * and another replica took the row, the late write matches nothing. A call
   * that never settles is reclaimed when the lease expires, as before.
   */
  private async runOneDelivery(delivery: ClaimedDelivery): Promise<void> {
    let providerMessageId: string | undefined;
    let work: Promise<string | undefined> | undefined;

    try {
      const event = delivery.event;

      if (!event) {
        throw new NonRetryableDeliveryError("Outbox event no longer exists");
      }

      work = this.executeDelivery(delivery, {
        topic: event.topic,
        payload: event.payload as unknown as AnyPayload,
        businessId: event.businessId,
        created_at: event.created_at,
      });

      providerMessageId = await this.withDeliveryTimeout(
        work,
        `${delivery.channel} delivery ${delivery.id}`,
      );
    } catch (error) {
      if (error instanceof DeliveryBackstopTimeoutError && work) {
        log.warn(
          { ...this.deliveryLogFields(delivery), error: error.message },
          "notification delivery overran its budget; its outcome is recorded when the provider answers",
        );

        void work
          .then(
            (lateMessageId) =>
              this.recordDeliverySuccess(delivery, lateMessageId),
            (sendError) => this.recordDeliveryFailure(delivery, sendError),
          )
          .catch((settleError) => {
            // Still PROCESSING: the lease hands it to another replica.
            log.error(
              { ...this.deliveryLogFields(delivery), err: settleError },
              "late notification delivery outcome could not be recorded",
            );
          });

        return;
      }

      await this.recordDeliveryFailure(delivery, error);
      return;
    }

    await this.recordDeliverySuccess(delivery, providerMessageId);
  }

  /**
   * Records DELIVERED for a send the provider ACCEPTED. A database outage at
   * that instant must not turn into a second WhatsApp: the write is retried
   * (detached once the quick retries run out) until shortly before this
   * claim's lease ends — see shared/resilience/record-accepted-outcome.ts.
   */
  private async recordDeliverySuccess(
    delivery: ClaimedDelivery,
    providerMessageId: string | undefined,
  ): Promise<void> {
    const fields = () => ({
      ...this.deliveryLogFields(delivery),
      providerMessageId: providerMessageId ?? null,
    });

    await recordAcceptedOutcome({
      deadline: recordDeadline(
        delivery.claimStartedAtMs ?? Date.now(),
        DELIVERY_LEASE_SECONDS,
      ),
      write: async () => {
        const settled = await this.settleDelivery(delivery, {
          status: "DELIVERED",
          deliveredAt: new Date(),
          leaseExpiresAt: null,
          lastError: null,
          // Only the channels that talk to an external provider return one.
          // It is what makes a duplicate report answerable after the fact:
          // which message, under which provider id, accepted when.
          ...(providerMessageId ? { providerMessageId } : {}),
        });

        // "Did it go out?" had no answer in the logs: success wrote nothing.
        // `superseded` marks a claim another replica had already taken over —
        // the message went out from here too, so the recipient may have two.
        log.info(
          { ...fields(), ...(settled.count === 0 ? { superseded: true } : {}) },
          "notification delivery accepted",
        );
      },
      onDetached: (error) => {
        log.warn(
          { ...fields(), err: error },
          "notification delivery accepted but not yet recorded; retrying the record until the lease is about to end",
        );
      },
      onGiveUp: (error) => {
        // Still PROCESSING: the lease hands it to another replica, which
        // sends it again under the same delivery id.
        log.error(
          { ...fields(), err: error },
          "notification delivery accepted by the provider but not recorded; it will be sent again when the lease expires",
        );
      },
      track: (pending) => {
        this.pendingRecords.add(pending);
        void pending.finally(() => this.pendingRecords.delete(pending));
      },
    });
  }

  /**
   * Stops WAITING on a delivery that overran its budget - it cannot cancel
   * the work already in flight (each provider owns its own request timeout),
   * but it keeps one hung await from holding the rest of the batch past its
   * lease, which is what would let another replica send those messages
   * again. The rejection is a DeliveryBackstopTimeoutError, never a failed
   * send: the caller keeps following the work it stopped waiting for.
   */
  private async withDeliveryTimeout<T>(
    work: Promise<T>,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DeliveryBackstopTimeoutError(
                  `${label} excedeu ${PER_DELIVERY_TIMEOUT_MS}ms sem resposta do provedor`,
                ),
              ),
            PER_DELIVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One lane's batch. Each lane has its own partial index (see migration
   * 20260923120000_notification_delivery_lanes), so the internal lane never
   * walks past a backlog of e-mails to find the next bell.
   *
   * The index is keyed on availableAt (20260924091000), and the claim writes
   * the lease end into availableAt as well as leaseExpiresAt. One range on
   * the key then covers both halves of the queue — a PENDING row is due when
   * its backoff is over, a PROCESSING row when its lease is — so the scan
   * starts at the oldest due row and stops at now(). It used to order by
   * created_at under an OR, and a WhatsApp outage parked tens of thousands of
   * retrying rows at the head of the lane that every e-mail claim then read
   * through in the heap.
   *
   * The explicit lease check stays for rows an older release claimed without
   * moving availableAt: during a rolling deploy those still carry the due
   * time they were claimed at, and must not be taken while their lease lives.
   */
  private async claimDeliveries(
    lane: DeliveryLane,
    limit: number = DELIVERY_BATCH_SIZE,
  ): Promise<ClaimedDelivery[]> {
    const floor = await claimFloors.predicate("deliveries");

    // A row whose last allowed attempt died with the process is left out
    // (attempts < DELIVERY_MAX_ATTEMPTS) and closed by the minute's sweep
    // (closeExhausted, plano-escala F3-08). Closed here, before every claim,
    // the UPDATE walked the lane's claim index — every due row, PENDING
    // ones included — to find the few PROCESSING ones: a flood of due
    // e-mails made each claim read the whole flood first.
    const claimStartedAtMs = Date.now();

    // The fair claim (plano-escala F3-10), read on every claim: company by
    // company from this lane's cursor, at most QUEUE_FAIR_ROWS_PER_TENANT
    // of one company, the oldest due rows filling the rest. Off, the
    // oldest due rows of the lane, as before.
    if (env.QUEUE_FAIR_CLAIM_ENABLED) {
      const claimed = await database.$queryRaw<
        Array<ClaimedDelivery & { fairCursor?: string | null }>
      >(
        deliveryFairClaimSql(lane, {
          cursor: this.fairCursors[lane],
          limit,
          rowsPerTenant: env.QUEUE_FAIR_ROWS_PER_TENANT,
          maxTenants: env.QUEUE_FAIR_MAX_TENANTS,
          floor,
          rowFloor: await claimFloors.predicate("deliveries", "row"),
        }),
      );

      this.fairCursors[lane] = nextFairCursor(claimed, this.fairCursors[lane]);

      for (const delivery of claimed) {
        delete delivery.fairCursor;
        delivery.claimStartedAtMs = claimStartedAtMs;
      }

      return claimed;
    }

    const claimed = await database.$queryRaw<ClaimedDelivery[]>(
      deliveryClaimSql(lane, floor, limit),
    );

    for (const delivery of claimed)
      delivery.claimStartedAtMs = claimStartedAtMs;

    return claimed;
  }

  private async executeDelivery(
    delivery: ClaimedDelivery,
    event: {
      topic: string;
      payload: AnyPayload;
      businessId: string | null;
      created_at: Date;
    },
  ): Promise<string | undefined> {
    const policy = getNotificationPolicy(event.topic) as AnyPolicy | null;

    if (!policy) {
      throw this.unknownToThisBuild(
        event.created_at,
        `No notification policy registered for topic "${event.topic}"`,
      );
    }

    // A user's e-mail, WhatsApp or push about a fact that stopped being true
    // (a tower request decided or superseded while its rows waited, or were
    // retried) is not sent. Asked on every attempt, like an outsider's
    // message (loadExternalMessage); only policies that define it pay the
    // lookup.
    if (
      delivery.userId &&
      policy.supersededReason &&
      OUT_OF_PRODUCT_CHANNELS.has(delivery.channel)
    ) {
      const superseded = await policy.supersededReason(
        event.payload,
        this.supersedeDeps(),
      );

      if (superseded) throw new NonRetryableDeliveryError(superseded);
    }

    switch (delivery.channel) {
      case NotificationChannel.IN_APP:
        return this.deliverInApp(delivery, event.payload, policy, event);
      case NotificationChannel.EMAIL:
        return this.deliverEmail(delivery, event.payload, policy);
      case NotificationChannel.WHATSAPP:
        return this.deliverWhatsApp(delivery, event.payload, policy);
      case NotificationChannel.PUSH:
        return this.deliverPush(delivery, event.payload, policy, event);
      case NotificationChannel.ACTIVITY:
        return this.deliverActivity(delivery, event.payload, policy, event);
      default:
        throw this.unknownToThisBuild(
          event.created_at,
          `Unknown delivery channel "${delivery.channel}"`,
        );
    }
  }

  /**
   * What an older build says about work a newer one created: not yet mine,
   * within the patience window; a real failure after it.
   */
  private supersedeDeps(): PolicyDeps {
    return {
      userRepository: container.resolve<IUserRepository>("UserRepository"),
      externalRecipientRepository: container.resolve(
        "ExternalRecipientRepository",
      ),
      messageTemplateRepository: container.resolve(
        "DeliveryMessageTemplateRepository",
      ),
      businessRepository: container.resolve("BusinessRepository"),
      occurrenceAuthorizationRepository: container.resolve(
        "OccurrenceAuthorizationRepository",
      ),
    };
  }

  private unknownToThisBuild(createdAt: Date, reason: string): Error {
    const age = Date.now() - new Date(createdAt).getTime();

    return age < UNKNOWN_TOPIC_PATIENCE_MS
      ? new DeferredDeliveryError(reason)
      : new NonRetryableDeliveryError(reason);
  }

  /**
   * Somebody whose access was revoked keeps no channel outside the product.
   * The in-app row is harmless — they cannot sign in to read it — but an
   * e-mail, a WhatsApp or a push carries the tenant's data to a person the
   * tenant removed.
   */
  private assertStillReachable(user: RecipientUser): void {
    if ((user as { access_revoked?: boolean }).access_revoked) {
      throw new NonRetryableDeliveryError(
        "Recipient's access was revoked; nothing is sent outside the product",
      );
    }
  }

  /**
   * System-tray push via Expo. A push-only topic (chat) renders through
   * `renderPush`; every other topic reuses the in-app render (push IS the
   * in-app message, on the phone's tray) and its data payload tells the app
   * to open the notifications screen on tap — and, since wave 3, which item
   * and whose (push-data.ts). Dead tokens reported by the provider are
   * pruned so they stop generating work.
   */
  private async deliverPush(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    event: { businessId: string | null },
  ): Promise<undefined> {
    if (!policy.renderPush && !policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel PUSH for a topic without push or in-app content",
      );
    }

    const userId = this.requireUserId(delivery);

    const user = await this.findRecipient(userId, delivery.recipientCache);
    this.assertStillReachable(user);

    const recipient = { id: user.id, role: user.role, driverId: user.driverId };

    // The same company the inbox row stores (deliverInApp), so the app can
    // compare a tray notice with the row and with its session.
    const owner = { userId: user.id, businessId: event.businessId };

    const content = policy.renderPush
      ? (() => {
          const rendered = policy.renderPush!(payload, recipient);

          return {
            title: rendered.title,
            body: rendered.body,
            data: withPushOwner(
              rendered.data ?? { url: "/notifications" },
              owner,
            ),
          };
        })()
      : (() => {
          const rendered = policy.renderInApp!(
            payload,
            { baseUrl: env.HTTP_REQUEST },
            recipient,
          );

          return {
            title: rendered.title,
            body: rendered.message,
            data: inAppPushData(rendered, owner),
          };
        })();

    const devices = await database.pushDeviceToken.findMany({
      where: { userId },
    });

    if (devices.length === 0) {
      throw new NonRetryableDeliveryError(
        "Recipient no longer has a registered push device",
      );
    }

    const { deliveredAny, invalidTokens, tickets } = await sendExpoPushMessages(
      devices.map((device) => device.token),
      // The delivery id rides along: the app can tell a repeated tray message
      // apart, and support can trace one back. It is also the collapse key,
      // so a redelivery of this same row replaces the tray message instead
      // of showing it twice (push-provider.ts).
      {
        ...content,
        data: { ...content.data, deliveryId: delivery.id },
        collapseKey: delivery.id,
        // The topic's validity (D41): a stale "rota liberada" is worse than
        // none on a phone that comes back after days.
        ttlSeconds: policy.pushTtlSeconds,
      },
      // Collapsing in transit is iPhone-only: on Android it would cap what
      // FCM keeps for an offline phone at four messages.
      new Set(
        devices
          .filter((device) => device.platform === "ios")
          .map((device) => device.token),
      ),
    );

    if (invalidTokens.length > 0) {
      await database.pushDeviceToken
        .deleteMany({ where: { token: { in: invalidTokens } } })
        .catch(() => undefined);
    }

    if (!deliveredAny) {
      // Every device was dead: nothing left to push at, and retrying cannot
      // conjure a device back.
      if (invalidTokens.length === devices.length) {
        throw new NonRetryableDeliveryError(
          "Every push token of the recipient is no longer registered",
        );
      }

      throw new Error("Expo não aceitou nenhum ticket de push");
    }

    // No single provider id: Expo answers with one ticket PER DEVICE. Each
    // goes to the receipts ledger instead, where check-push-receipts-job
    // turns it into FCM/APNs' verdict and prunes the devices that are gone.
    // Best effort: the push already went out, and failing the delivery here
    // would only send it again.
    await recordExpoTickets(delivery.id, tickets).catch((error) => {
      log.warn(
        { ...this.deliveryLogFields(delivery), err: error },
        "push tickets could not be recorded",
      );
    });

    return undefined;
  }

  private async deliverInApp(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    event: { businessId: string | null },
  ): Promise<undefined> {
    if (!policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel IN_APP for a topic without in-app content",
      );
    }

    const userId = this.requireUserId(delivery);
    const user = await this.findRecipient(userId, delivery.recipientCache);

    const rendered = policy.renderInApp(
      payload,
      { baseUrl: env.HTTP_REQUEST },
      { id: user.id, role: user.role, driverId: user.driverId },
    );

    try {
      const notification = await database.notification.create({
        data: {
          // The delivery's id (plano-escala F5-14): a retried IN_APP hits
          // the primary key, with or without the unique on deliveryId,
          // which goes when the bell is partitioned by month (F5-15).
          id: delivery.id,
          userId,
          type: rendered.type,
          title: rendered.title,
          message: rendered.message,
          link: rendered.link,
          entityId: rendered.entityId,
          businessId: event.businessId,
          deliveryId: delivery.id,
        },
      });

      sendNotificationToUser(userId, {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        link: notification.link || undefined,
        read: notification.read,
        entityId: notification.entityId || undefined,
        businessId: notification.businessId,
        created_at: notification.created_at,
      });
    } catch (error) {
      // The row is there (primary key or unique deliveryId): a previous
      // attempt already created it (crash before the DELIVERED mark). Done —
      // and no duplicate emit. If that attempt died before ITS emit, the
      // toast is lost: the emit is at-most-once by design, the bell is the
      // truth (ADR 0003). A row the image before F5-14 wrote under a random
      // id is caught by the unique deliveryId, which stays until F5-15 —
      // releases after any delivery of that image stopped being retried.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }

      throw error;
    }
  }

  /**
   * E-mail is the one external channel whose provider can deduplicate: the
   * delivery id travels as Resend's idempotency key (see ResendMailProvider),
   * so a retry of a message Resend already accepted — after a crash, a lost
   * answer or an abandoned wait — is recognised there and not sent twice, for
   * 24 hours. The whole retry schedule fits inside that window.
   */
  private async deliverEmail(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<string | undefined> {
    // Somebody with no account. A different message, in the company's words,
    // to an address that has no inbox behind it.
    if (delivery.externalRecipientId) {
      return this.deliverExternalEmail(delivery, payload, policy);
    }

    if (!policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel EMAIL for a topic without in-app content",
      );
    }

    const user = await this.findRecipient(
      this.requireUserId(delivery),
      delivery.recipientCache,
    );

    this.assertStillReachable(user);

    // Expansion never queues an EMAIL row for a user without an address
    // (hasEmail); this is the e-mail removed after the row was queued, the
    // same as a WhatsApp phone removed in between.
    if (!user.email) {
      throw new NonRetryableDeliveryError(
        "Recipient no longer has an e-mail address",
      );
    }

    const rendered = policy.renderInApp(
      payload,
      { baseUrl: env.HTTP_REQUEST },
      { id: user.id, role: user.role, driverId: user.driverId },
    );

    const mailProvider = container.resolve<IMailProvider>("MailProvider");

    // Same path the deleted worker built: templates are read from `src`,
    // which the image ships, in every environment.
    const templatePath = resolve(
      process.cwd(),
      "src",
      "modules",
      NOTIFICATION_TEMPLATE_MODULE,
      "views",
      NOTIFICATION_TEMPLATE_FILE,
    );

    const [firstName] = user.name?.split(" ") ?? ["Usuario"];

    return this.sendMailClassified(mailProvider, {
      to: user.email,
      subject: `Trajetto - ${rendered.title}`,
      path: templatePath,
      // The delivery id is unique per (event, recipient, channel), so it
      // is exactly the reference a mail provider needs to tell two
      // notifications apart - and to recognise our own retry.
      referenceId: delivery.id,
      variables: {
        name: firstName,
        year: new Date().getFullYear(),
        title: rendered.title,
        message: rendered.message,
        link: rendered.link || `${env.HTTP_REQUEST}/notifications`,
        logo: emailLogoUrl(),
      },
    });
  }

  /**
   * Awaited on purpose: the row only becomes DELIVERED when the transport
   * actually accepted the message. A permanent refusal (invalid recipient,
   * bad credentials, missing template) must not burn the retry budget — on
   * either path: the external one used to retry an SMTP 5xx five times.
   */
  private async sendMailClassified(
    mailProvider: IMailProvider,
    message: Parameters<IMailProvider["sendMail"]>[0],
  ): Promise<string | undefined> {
    try {
      const sent = await mailProvider.sendMail(message);

      return sent?.messageId;
    } catch (error) {
      if (error instanceof MailDeliveryError) {
        // The SMTP code and reply go with it into lastError (OBS-08): EAUTH or
        // a 535 is a credential to fix, a 550 is one mailbox.
        const detail: ProviderErrorDetail = {
          provider: "email",
          smtpCode: error.code,
          smtpReply: error.responseCode,
        };

        if (!error.retryable) {
          throw new NonRetryableDeliveryError(error.message, detail);
        }

        throw new RetryableDeliveryError(error.message, undefined, detail);
      }

      throw error;
    }
  }

  private async deliverWhatsApp(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<string | undefined> {
    if (delivery.externalRecipientId) {
      return this.deliverExternalWhatsApp(delivery, payload, policy);
    }

    if (!policy.renderWhatsApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel WHATSAPP for a topic without WhatsApp content",
      );
    }

    const user = await this.findRecipient(
      this.requireUserId(delivery),
      delivery.recipientCache,
    );

    this.assertStillReachable(user);

    if (!user.whatsapp_phone) {
      throw new NonRetryableDeliveryError(
        "Recipient no longer has a WhatsApp phone configured",
      );
    }

    // The card is the master key (pipeline-rules.ts): a row queued before
    // the person switched it off is not sent either. The number stays
    // stored after that, so the phone check above lets it through.
    if (!user.whatsapp_notifications_enabled) {
      throw new NonRetryableDeliveryError("Recipient turned WhatsApp off");
    }

    const rendered = policy.renderWhatsApp(payload, {
      id: user.id,
      role: user.role,
      driverId: user.driverId,
    });

    // Expansion asked the same render before creating this row; a null now
    // is a payload that changed meaning in between — nothing to send.
    if (!rendered) {
      throw new NonRetryableDeliveryError(
        "The WhatsApp render has nothing for this recipient",
      );
    }

    // The approved template and its fitted parameters (whatsapp-templates.ts,
    // B1). A render that does not match its template is a bug that fails the
    // same way on every attempt, so it is not retried.
    let template: { name: string; parameters: string[] };

    try {
      template = prepareInternalWhatsApp(rendered);
    } catch (error) {
      if (error instanceof WhatsAppTemplateMismatchError) {
        throw new NonRetryableDeliveryError(error.message);
      }

      throw error;
    }

    const whatsAppProvider =
      container.resolve<IWhatsAppProvider>("WhatsAppProvider");

    const result = await whatsAppProvider.sendMessage({
      phoneNumber: user.whatsapp_phone,
      template,
      // Comes back on Meta's status callbacks: every wamid of this delivery,
      // a resend after a crash included, lands in the receipts ledger.
      referenceId: delivery.id,
    });

    return this.whatsAppOutcome(result);
  }

  /**
   * Meta's wamid on success, so a duplicate report can be traced to one send
   * or two. On failure the provider's own classification decides: a rejected
   * template or a number without WhatsApp can never succeed, and retrying it
   * only spends the account's quality rating; a throttled send comes back no
   * sooner than Meta asked.
   */
  private whatsAppOutcome(result: {
    success: boolean;
    messageId?: string;
    message?: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    httpStatus?: number;
    errorCode?: number;
  }): string | undefined {
    if (result.success) return result.messageId;

    const reason = result.message || "Falha ao enviar WhatsApp";

    // Meta's status and code go into lastError with the sentence (OBS-08):
    // 190 is an expired token, 131026 a number without WhatsApp.
    const detail: ProviderErrorDetail = {
      provider: "whatsapp",
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
    };

    if (result.retryable === false) {
      throw new NonRetryableDeliveryError(reason, detail);
    }

    throw new RetryableDeliveryError(
      reason,
      result.retryAfterSeconds ? result.retryAfterSeconds * 1000 : undefined,
      detail,
    );
  }

  /**
   * The message a company sends to somebody outside it.
   *
   * Three things differ from the internal path and each of them is the point:
   *
   *  - the WORDS are the company's on the e-mail, from their own template;
   *    on WhatsApp they are the moment's fixed template approved by Meta
   *    (plan of 02/11/2026, B2), with the carrier's name in it;
   *  - the LINK is their tracking page, not a dashboard they cannot open;
   *  - a missing or switched-off row is a DECISION. A carrier that turned
   *    the "saiu para entrega" message off does not want one sent, so the
   *    delivery is dropped as non-retryable rather than failing forever.
   */
  private async loadExternalMessage(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    channel: string,
  ) {
    if (!policy.renderExternal || !policy.resolveExternalRecipients) {
      throw new NonRetryableDeliveryError(
        `Delivery addressed to an external recipient on a topic that does not write to one`,
      );
    }

    const externalRecipientRepository = container.resolve(
      "ExternalRecipientRepository",
    );

    const deps = {
      userRepository: container.resolve<IUserRepository>("UserRepository"),
      externalRecipientRepository,
      messageTemplateRepository: container.resolve(
        "DeliveryMessageTemplateRepository",
      ),
      businessRepository: container.resolve("BusinessRepository"),
    };

    const external = await database.externalRecipient.findUnique({
      where: { id: delivery.externalRecipientId! },
    });

    if (!external) {
      throw new RecipientGoneError("External recipient no longer exists");
    }

    // Asked to stop between the row being created and the worker reaching it.
    // A message sent after somebody opted out is the one failure in this whole
    // feature that a customer reports to the provider.
    if (external.opted_out_at) {
      throw new NonRetryableDeliveryError(
        "External recipient opted out before this message was sent",
      );
    }

    // Or opted out from another delivery of this company since (D38): the
    // phone or e-mail this channel writes to is suppressed. Asked on every
    // attempt, so a message already queued is dropped the moment they click.
    const blocked = await this.suppressedChannelsOf(external.businessId, {
      email: channel === NotificationChannel.EMAIL ? external.email : null,
      telephone:
        channel === NotificationChannel.WHATSAPP ? external.telephone : null,
    });

    if (blocked.size > 0) {
      throw new NonRetryableDeliveryError(SUPPRESSED_ADDRESS_REASON);
    }

    // The three customer messages are separate events on separate retry
    // schedules: a "saiu para entrega" in backoff used to land after the
    // "entregue" that overtook it. Asked on every attempt, so a message still
    // waiting stops the moment the delivery moves past it (GAP2-5).
    const superseded = await policy.supersededReason?.(payload, deps);

    if (superseded) throw new NonRetryableDeliveryError(superseded);

    // A company template that cannot render fails the same way on every
    // attempt: retrying it only delays the dead letter by half an hour while
    // the customer hears nothing. It is the company's to fix, so it fails now.
    const rendered = await policy
      .renderExternal(payload, external, deps, channel)
      .catch((error: unknown) => {
        if (error instanceof InvalidMessageTemplateError) {
          throw new NonRetryableDeliveryError(
            `Company ${channel} template cannot be rendered: ${error.message}`,
          );
        }

        throw error;
      });

    if (!rendered) {
      throw new NonRetryableDeliveryError(
        `No active ${channel} template for this company and moment`,
      );
    }

    return { external, rendered };
  }

  /**
   * The channels a company's customers asked to stop at this contact's
   * phone or e-mail (D38). Only customer messages ask; a company-less event
   * has no customer to suppress.
   */
  private async suppressedChannelsOf(
    businessId: string | null,
    contact: { email: string | null; telephone: string | null },
  ): Promise<Set<"EMAIL" | "WHATSAPP">> {
    if (!businessId) return new Set();

    return container
      .resolve<IExternalRecipientRepository>("ExternalRecipientRepository")
      .suppressedChannels(businessId, {
        email: contact.email,
        telephone: contact.telephone,
      });
  }

  private async deliverExternalEmail(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<string | undefined> {
    const { external, rendered } = await this.loadExternalMessage(
      delivery,
      payload,
      policy,
      NotificationChannel.EMAIL,
    );

    if (!external.email) {
      throw new NonRetryableDeliveryError(
        "External recipient no longer has an e-mail address",
      );
    }

    // The valid addresses only, never the stored text: what reaches the
    // transport's address parser is a list this API checked.
    const addresses = readRecipientEmails(external.email).addresses;

    if (addresses.length === 0) {
      throw new NonRetryableDeliveryError(
        "External recipient has no valid e-mail address",
      );
    }

    const mailProvider = container.resolve<IMailProvider>("MailProvider");

    const templatePath = resolve(
      process.cwd(),
      "src",
      "modules",
      NOTIFICATION_TEMPLATE_MODULE,
      "views",
      NOTIFICATION_TEMPLATE_FILE,
    );

    const [firstName] = external.name?.split(" ") ?? ["Cliente"];

    return this.sendMailClassified(mailProvider, {
      // Each one passed the e-mail check, so none holds a comma to split on.
      to: addresses.join(", "),
      subject: rendered.subject,
      path: templatePath,
      referenceId: delivery.id,
      variables: {
        name: firstName,
        year: new Date().getFullYear(),
        title: rendered.subject,
        message: rendered.body,
        link: rendered.link,
        logo: emailLogoUrl(),
      },
    });
  }

  private async deliverExternalWhatsApp(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<string | undefined> {
    const { external, rendered } = await this.loadExternalMessage(
      delivery,
      payload,
      policy,
      NotificationChannel.WHATSAPP,
    );

    if (!external.telephone) {
      throw new NonRetryableDeliveryError(
        "External recipient no longer has a phone number",
      );
    }

    // The moment's fixed template (B2). A render without it is a policy that
    // never learnt the fixed templates — nothing a retry can fix, and never
    // a reason to fall back to free text.
    if (!rendered.whatsapp) {
      throw new NonRetryableDeliveryError(
        "Customer WhatsApp rendered without its approved template",
      );
    }

    const whatsAppProvider =
      container.resolve<IWhatsAppProvider>("WhatsAppProvider");

    const result = await whatsAppProvider.sendMessage({
      phoneNumber: external.telephone,
      template: rendered.whatsapp,
      referenceId: delivery.id,
    });

    return this.whatsAppOutcome(result);
  }

  private async deliverActivity(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    event: { businessId: string | null },
  ): Promise<undefined> {
    if (!policy.renderActivity) {
      throw new NonRetryableDeliveryError(
        "Delivery channel ACTIVITY for a topic without activity content",
      );
    }

    const rendered = policy.renderActivity(payload);

    // Same dynamic import the old NotificationService used — the activity
    // module imports shared services, so a static import here would cycle.
    const { CreateActivityUseCase } =
      await import("@/modules/activity/usecases/create-activity/create-activity-usecase");

    const createActivityUseCase = container.resolve(CreateActivityUseCase);
    const performedBy = this.requireUserId(delivery);

    try {
      await createActivityUseCase.execute({
        type: rendered.type,
        action: rendered.action,
        entityId: rendered.entityId,
        description: rendered.description,
        status: rendered.status,
        performedBy,
        businessId: event.businessId,
        tenantName: rendered.tenantName,
        visibilityLevel: rendered.visibilityLevel,
        performingUserRole: rendered.performingUserRole,

        // Makes this write idempotent, the same way IN_APP already is. The
        // audit trail is our own table, so a duplicate here is entirely
        // preventable — and a trail that double-counts is worse than one
        // that is merely incomplete, because it is confidently wrong.
        deliveryId: delivery.id,
      });
    } catch (error) {
      // The trail's row names its actor by a foreign key, so an actor
      // deleted since the event fails the write. Asked only on that path:
      // the happy one pays no lookup. The cascade of today took this row
      // with the actor; it closes the same way (F5-05, D54).
      const actor = await database.user.findUnique({
        where: { id: performedBy },
        select: { id: true },
      });

      if (!actor) {
        throw new RecipientGoneError("Activity actor no longer exists");
      }

      throw error;
    }

    // No provider: the activity trail is our own table.
    return undefined;
  }

  /**
   * The user behind a delivery row, or a refusal that will not be retried.
   *
   * A row with no `userId` reached a channel only a User has — an inbox, a
   * push device, an activity trail. That is a bug in whoever created the row,
   * and no amount of retrying will grow the outsider an account, so it fails
   * once and stays failed with a sentence that names the cause.
   */
  private requireUserId(delivery: ClaimedDelivery): string {
    if (!delivery.userId) {
      throw new NonRetryableDeliveryError(
        `Delivery channel ${delivery.channel} requires a user, and this row addresses an external recipient`,
      );
    }

    return delivery.userId;
  }

  private async findRecipient(
    userId: string,
    cache: RecipientCache | undefined,
  ): Promise<RecipientUser> {
    const cached = cache?.get(userId);
    if (cached) return cached;

    const lookup = (async (): Promise<RecipientUser> => {
      const userRepository =
        container.resolve<IUserRepository>("UserRepository");

      const user = await userRepository.findUserById(userId);

      if (!user) {
        throw new RecipientGoneError("Recipient user no longer exists");
      }

      return user;
    })();

    // Cached before the await so two workers on the same recipient share one
    // query. A rejected lookup is evicted: the next delivery of this batch
    // deserves a real attempt instead of a memoised failure.
    cache?.set(userId, lookup);

    lookup.catch(() => cache?.delete(userId));

    return lookup;
  }

  private async recordDeliveryFailure(
    delivery: ClaimedDelivery,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof DeferredDeliveryError) {
      // Not ours yet: back to the queue as it was, without spending one of
      // its attempts, for a replica that knows this topic.
      await this.settleDelivery(delivery, {
        status: "PENDING",
        attempts: { decrement: 1 },
        availableAt: new Date(Date.now() + UNKNOWN_TOPIC_RECHECK_MS),
        leaseExpiresAt: null,
        lastError: `${message} (aguardando uma versão que conheça o tópico)`,
      }).catch((updateError) => {
        log.error(
          { ...this.deliveryLogFields(delivery), err: updateError },
          "deferred notification delivery could not be put back",
        );
      });

      return;
    }

    // From here on, lastError and the log line carry the provider's codes in
    // a bracket other code keys on: `[whatsapp http=401 code=190] ...`
    // (OBS-08; the ops alerting reads it for credential failures).
    const stored = formatDeliveryError(
      message,
      providerDetailOf(error, delivery.channel),
    );

    const baseDelay =
      error instanceof NonRetryableDeliveryError
        ? null
        : nextRetryDelayMs(delivery.attempts, DELIVERY_RETRY_DELAYS_MS);

    // Jitter keeps a rate-limited batch from marching back in lockstep; a
    // provider's Retry-After, when it gave one, sets the floor.
    const delay =
      baseDelay === null
        ? null
        : honourRetryAfter(
            withRetryJitter(baseDelay),
            error instanceof RetryableDeliveryError
              ? error.retryAfterMs
              : undefined,
          );

    const fields = {
      ...this.deliveryLogFields(delivery),
      willRetry: delay !== null,
      nextAttemptAt:
        delay === null ? null : new Date(Date.now() + delay).toISOString(),
      error: stored,
    };

    // A retry is expected traffic (warn); a delivery that gave up is a
    // message somebody will never get (error).
    if (delay === null) {
      log.error(fields, "notification delivery failed");
    } else {
      log.warn(fields, "notification delivery failed");
    }

    await this.settleDelivery(
      delivery,
      delay === null
        ? { status: "FAILED", leaseExpiresAt: null, lastError: stored }
        : {
            status: "PENDING",
            availableAt: new Date(Date.now() + delay),
            leaseExpiresAt: null,
            lastError: stored,
          },
    ).catch((updateError) => {
      log.error(
        { ...this.deliveryLogFields(delivery), err: updateError },
        "notification delivery failure could not be recorded",
      );
    });
  }

  /** The ids a delivery's log lines are found by (OBS-06). */
  private deliveryLogFields(delivery: ClaimedDelivery) {
    return {
      deliveryId: delivery.id,
      outboxEventId: delivery.outboxEventId,
      correlationId: delivery.event?.correlationId ?? null,
      topic: delivery.event?.topic ?? null,
      businessId: delivery.event?.businessId ?? null,
      channel: delivery.channel,
      attempt: delivery.attempts,
    };
  }
}

export {
  NotificationPipelineService,
  deliveryClaimSql,
  deliveryFairClaimSql,
  outboxClaimSql,
};
