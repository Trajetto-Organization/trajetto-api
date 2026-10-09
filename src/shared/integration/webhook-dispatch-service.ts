import database from "@/../infra/database";

import { Prisma, WebhookDeliveryStatus } from "@prisma/client";

import {
  ENDPOINT_PAUSED_REASON,
  MAX_CONSECUTIVE_FAILURES,
  REPLAY_WINDOW_DAYS,
  REPLAY_WINDOW_EXPIRED_REASON,
  RESPONSE_READ_LIMIT_BYTES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_CLAIM_WINDOW,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_DRAIN_BUDGET_MS,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_PER_ENDPOINT_BATCH,
  WEBHOOK_PER_ENDPOINT_CONCURRENCY,
  WEBHOOK_TIMEOUT_MS,
  assertWebhookLeaseInvariant,
  inFairPool,
  isOutsideReplayWindow,
  isWebhookPermanent,
  isWebhookSuccess,
  nextWebhookDelayMs,
  parkedUntil,
  truncateResponseBody,
} from "./webhook-dispatch-rules";

import { OutboxService } from "@/shared/notifications/outbox-service";
import {
  recordAcceptedOutcome,
  recordDeadline,
} from "@/shared/resilience/record-accepted-outcome";

import { signWebhookPayload } from "./webhook-signature";
import { openHeaders, openSecret } from "./secret-box";
import { readBoundedBody } from "./bounded-body";
import { endpointWantsTopic } from "./webhook-catalogue";
import {
  UNREACHABLE_REASON,
  UNRESOLVED_REASON,
  createWebhookAgent,
  safeWebhookHeaders,
  verifyWebhookDestination,
} from "./webhook-destination";

import { withRetryJitter } from "@/shared/notifications/pipeline-rules";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { logger } from "@/shared/logging/logger";
import { providerMetrics } from "@/shared/health/provider-metrics";
import { getRequestContext } from "@/shared/http/request-context";

import { v7 as uuidV7 } from "uuid";

/** The shared logger (OBS-14): one structured line per event, by component. */
const log = logger.child({ component: "webhook-dispatch" });

import { fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * One agent for every webhook of the process: pooled connections, and each
 * one made only to an address the guarded lookup validated — see
 * `createWebhookAgent`.
 */
const webhookAgent = createWebhookAgent();

/**
 * What the monitor says about a call that never got an HTTP answer.
 *
 * One sentence per kind of failure a customer can act on, never the raw
 * error, and no latency: "refused in 1 ms" against "no answer in 10 s" was a
 * port scanner for whatever address the name resolved to.
 */
function networkFailureReason(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? "";

  // Node's TLS codes: ERR_TLS_*, CERT_HAS_EXPIRED, *_SELF_SIGNED_CERT*,
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE.
  if (
    code.startsWith("ERR_TLS_") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return "O certificado TLS do endpoint foi recusado.";
  }

  return "Falha de rede ao chamar o endpoint.";
}

/**
 * Calls the customers' systems, and keeps the record of what happened.
 *
 * The same shape as the notification pipeline — claim with
 * `FOR UPDATE SKIP LOCKED`, a lease, a retry schedule — because the failure
 * modes are the same and a second design would be a second set of bugs. What
 * differs is who is on the other end: an endpoint we do not control, that can
 * hang, lie about its status, or answer with a megabyte of HTML.
 */
const BATCH_SIZE = 20;

assertWebhookLeaseInvariant(BATCH_SIZE);


interface ClaimedWebhook {
  id: string;
  endpointId: string;
  topic: string;
  payload: unknown;
  attempts: number;

  /** Where the replay window of a held row starts. */
  created_at: Date;

  /** Local clock taken before the claim: the lease ends no earlier. */
  claimStartedAtMs?: number;
}

/** Writes the notice that an endpoint was switched off — see `disableEndpoint`. */
const outbox = new OutboxService();

interface FanOutEvent {
  topic: string;
  businessId: string;

  /**
   * The public event id, sent as the body's `id` and as
   * `X-Trajetto-Event-Id`. Generated when absent — which is every production
   * call today.
   */
  sourceEventId?: string | null;

  payload: Record<string, unknown>;
}

/**
 * The row's `signature` column: a record of the signature at fan-out, never
 * what goes on the wire (`deliver` signs at send time).
 *
 * Best-effort on purpose. The fan-out runs inside the transaction of the
 * business write it announces, and a secret that cannot be opened —
 * WEBHOOK_SECRETS_KEY missing or wrong after the secrets were sealed — would
 * otherwise roll back the delivery, the route or the proof itself. The row is
 * written with an empty record instead; the send is what fails, and retries
 * once the key is fixed.
 */
function fanOutSignature(storedSecret: string, body: string): string {
  try {
    return signWebhookPayload(openSecret(storedSecret), body).header;
  } catch (error) {
    // The message only: nothing of the sealed secret belongs in a log line.
    log.error(
      { error: (error as Error).message },
      "endpoint secret unreadable at fan-out; the row is written unsigned",
    );

    return "";
  }
}

/**
 * The secret a rotation replaced, while it still signs — or nothing, when it
 * cannot be opened.
 *
 * A rotation is how a customer recovers from a lost WEBHOOK_SECRETS_KEY: the
 * new secret is sealed under the current key, and the old one may no longer
 * open. That must cost only the second signature, never the send.
 */
function previousSecretOf(stored: string): string[] {
  try {
    return [openSecret(stored)];
  } catch {
    return [];
  }
}

/**
 * What the monitor says about a send whose stored secret or headers could not
 * be opened (WEBHOOK_SECRETS_KEY missing or wrong). Ours, not the receiver's —
 * and a new secret plus the headers saved again is the way out when the key is
 * gone for good.
 */
const CREDENTIALS_UNREADABLE_REASON =
  "Não conseguimos ler as credenciais guardadas deste endpoint (segredo ou " +
  "cabeçalhos). A falha é nossa, não do seu servidor: o evento será tentado " +
  "de novo. Se persistir, gere um novo segredo e salve os cabeçalhos outra vez.";

/**
 * Turns one domain event into one row per interested endpoint.
 *
 * The BYTES are fixed here, once, with the event id in them: a retry three
 * hours later and a manual resend post the same body, so a receiver that
 * logged the first attempt can prove the second is the same event. The
 * signature over those bytes is computed again at send time — see `deliver`
 * for why a fan-out signature went stale.
 *
 * The payload is COPIED onto the row. The outbox is a work queue and is
 * purged; a customer asking us to resend last Tuesday must not depend on a row
 * deleted on Wednesday.
 */
async function fanOutWebhookEvent(
  event: FanOutEvent,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? database;

  // The customer's switch means unsubscribed: no row. OUR switch (the
  // breaker, `disabled_at`) is different — it used to drop every event while
  // it was open, and seven hours of an outage were lost for good. Those rows
  // are written now, held (see below), and go out once the endpoint is saved.
  const endpoints = await client.webhookEndpoint.findMany({
    where: {
      businessId: event.businessId,
      is_active: true,
    },
  });

  const subscribed = endpoints.filter((endpoint) =>
    endpointWantsTopic(endpoint.topics, event.topic),
  );

  if (subscribed.length === 0) return 0;

  // A held row has to meet the release of the save that switches its
  // endpoint back on. Read without a lock, a switched-off endpoint could be
  // saved while this transaction was still open: the save's release looked
  // before this row was committed, and the row sat out the whole window on a
  // working endpoint. FOR SHARE orders the two — the save waits for this
  // commit and then releases the row, or this read waits for the save and
  // sees the endpoint back on. Only switched-off endpoints are locked, and
  // only with a transaction to hold the lock.
  const switchedOff = subscribed.filter((endpoint) => endpoint.disabled_at !== null);

  if (switchedOff.length > 0 && !tx) {
    return database.$transaction((inner) => fanOutWebhookEvent(event, inner));
  }

  let interested = subscribed;

  if (switchedOff.length > 0) {
    const current = await client.$queryRaw<
      Array<{
        id: string;
        is_active: boolean;
        disabled_at: Date | null;
        topics: string[];
      }>
    >`
      SELECT "id", "is_active", "disabled_at", "topics"
      FROM "webhook_endpoint"
      WHERE "id" IN (${Prisma.join(switchedOff.map((endpoint) => endpoint.id))})
      ORDER BY "id"
      FOR SHARE
    `;

    const byId = new Map(current.map((row) => [row.id, row]));

    interested = subscribed.flatMap((endpoint) => {
      if (endpoint.disabled_at === null) return [endpoint];

      const fresh = byId.get(endpoint.id);

      // Deleted, paused or unsubscribed by the save this read waited for.
      if (
        !fresh ||
        !fresh.is_active ||
        !endpointWantsTopic(fresh.topics, event.topic)
      ) {
        return [];
      }

      return [{ ...endpoint, disabled_at: fresh.disabled_at }];
    });

    if (interested.length === 0) return 0;
  }

  // The id a receiver deduplicates on. Delivery is at-least-once, and the
  // only production caller never passed one, so a retried or resent event
  // arrived with nothing to tell it from a new fact. One id per domain event,
  // shared by every endpoint and kept by a manual resend (it copies the row).
  const eventId = event.sourceEventId ?? uuidV7();

  // The order a receiver can rebuild. Delivery is concurrent and retried, so
  // arrival order means nothing: a `delivery.in_transit` retried after a 503
  // lands after the `delivery.delivered` that followed it. Drawn inside the
  // caller's transaction, after its write: two writes to the same delivery or
  // route are serialised by that row's lock, so their numbers follow the
  // order of the facts. Increasing, with gaps (a rolled-back transaction
  // burns its number) — never a count.
  const [{ sequence }] = await client.$queryRaw<Array<{ sequence: bigint }>>`
    SELECT nextval('webhook_event_seq') AS "sequence"
  `;

  const body = JSON.stringify({
    id: eventId,
    sequence: Number(sequence),
    topic: event.topic,
    created_at: new Date().toISOString(),
    data: event.payload,
  });

  const rows = interested.map((endpoint) => {
    const signature = fanOutSignature(endpoint.secret, body);

    return {
      endpointId: endpoint.id,
      businessId: event.businessId,
      topic: event.topic,
      sourceEventId: eventId,

      // The queryable copy, for the monitor and for anybody asking what was
      // sent. NOT what goes on the wire — see `signed_body`.
      payload: JSON.parse(body) as Prisma.InputJsonValue,

      // What goes on the wire, byte for byte. JSONB is not a string: Postgres
      // parses it, reorders the keys and drops duplicates, so re-serialising
      // the column at send time produces a body the signature does not cover.
      // The receiver rejects it, and nothing on our side can tell — from here
      // the POST returned 200.
      signed_body: body,

      signature,

      // Held until the endpoint is saved again, within the replay window —
      // out of the claim's way meanwhile.
      ...(endpoint.disabled_at !== null && {
        availableAt: parkedUntil(new Date()),
        lastError: ENDPOINT_PAUSED_REASON,
      }),
    };
  });

  await client.webhookDelivery.createMany({ data: rows });

  // The link from the request that caused the event to what the customer
  // receives (X-Trajetto-Event-Id): the dispatcher's lines name the rows, this
  // one names the request (contract §32, correlation end to end).
  log.info(
    {
      correlationId: getRequestContext()?.requestId ?? null,
      sourceEventId: eventId,
      topic: event.topic,
      businessId: event.businessId,
      endpoints: rows.length,
    },
    "webhook event fanned out",
  );

  return rows.length;
}

/**
 * How many held rows one release statement makes due.
 *
 * The release was a single UPDATE. At roughly forty microseconds a row, a
 * month held for a busy tenant outlasted production's statement_timeout
 * (30 s), and the save that ran it failed on every retry: the endpoint could
 * never be switched back on. A batch this size is a fraction of a second.
 */
const RELEASE_BATCH_SIZE = 2_000;

/**
 * Sends what an endpoint was holding, now: called when somebody saves it
 * active again — the statement "I fixed it".
 *
 * Every PENDING row still inside the replay window is made due, the held ones
 * and those waiting out a backoff alike. Past the window a row stays held
 * until the dispatcher closes it. The held-reason is cleared; a real error
 * from a retry stays for the monitor.
 *
 * Run AFTER the save has committed, never inside its transaction: a row
 * written held by somebody who read the endpoint as switched off just before
 * the save is then either seen here or sees the endpoint back on (see
 * `releaseHeldRowIfEndpointBack` and the lock in `fanOutWebhookEvent`).
 *
 * In bounded batches, oldest first, walking (businessId, status, created_at)
 * with a cursor: a released row stays PENDING until the dispatcher takes it,
 * so starting every batch from the beginning would read the released ones
 * again, and the whole release would grow with the square of the backlog.
 */
async function releaseParkedWebhookDeliveries(
  endpointId: string,
  client: Prisma.TransactionClient = database,
): Promise<number> {
  const endpoint = await client.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: { businessId: true },
  });

  if (!endpoint) return 0;

  let from = new Date(Date.now() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let released = 0;

  for (;;) {
    // `picked` decides whether another batch is needed; `released` may be
    // smaller, when a row in backoff fell due and was claimed in between (the
    // outer condition is re-checked under the row lock).
    const [batch] = await client.$queryRaw<
      Array<{ picked: number; released: number; last: Date | null }>
    >`
      WITH "picked" AS (
        SELECT "id", "created_at"
        FROM "webhook_delivery"
        WHERE "businessId" = ${endpoint.businessId}
          AND "status" = 'PENDING'
          AND "created_at" >= ${from}
          AND "endpointId" = ${endpointId}
          AND "availableAt" > now()
        ORDER BY "created_at"
        LIMIT ${RELEASE_BATCH_SIZE}
      ), "released" AS (
        UPDATE "webhook_delivery" AS "delivery" SET
          "availableAt" = now(),
          "lastError" = CASE
            WHEN "delivery"."lastError" = ${ENDPOINT_PAUSED_REASON} THEN NULL
            ELSE "delivery"."lastError"
          END
        FROM "picked"
        WHERE "delivery"."id" = "picked"."id"
          AND "delivery"."status" = 'PENDING'
          AND "delivery"."availableAt" > now()
        RETURNING "delivery"."id"
      )
      SELECT
        (SELECT count(*) FROM "picked")::int AS "picked",
        (SELECT count(*) FROM "released")::int AS "released",
        (SELECT max("created_at") FROM "picked") AS "last"
    `;

    released += batch?.released ?? 0;

    if (!batch || batch.picked < RELEASE_BATCH_SIZE || !batch.last) {
      return released;
    }

    // `>=`, not `>`: rows of one transaction share their created_at, and a
    // batch can end in the middle of them. The released ones no longer match.
    from = batch.last;
  }
}

/**
 * Makes one held row due again if its endpoint is back.
 *
 * For whoever writes a row held after reading the endpoint as switched off,
 * without holding a lock on it (a worker parking a row, a manual resend). The
 * save may have committed in between, and its release — which runs after the
 * commit — did not see this row yet. Looking at the endpoint again AFTER the
 * row is written closes the gap: either this read sees the save, or the
 * save's release sees the row.
 */
async function releaseHeldRowIfEndpointBack(
  rowId: string,
  endpointId: string,
): Promise<void> {
  const endpoint = await database.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: { is_active: true, disabled_at: true },
  });

  if (!endpoint?.is_active || endpoint.disabled_at !== null) return;

  await database.webhookDelivery.updateMany({
    where: {
      id: rowId,
      status: WebhookDeliveryStatus.PENDING,
      lastError: ENDPOINT_PAUSED_REASON,
    },
    data: { availableAt: new Date(), lastError: null },
  });
}

/**
 * How often a replica looks for work.
 *
 * Five seconds, same as the notification pipeline. A webhook is not a chat
 * message — nobody is watching for it — but an integration that learns about a
 * delivery a minute late is an integration whose customer calls to ask why
 * their ERP is behind.
 */
const SWEEP_INTERVAL_MS = 5_000;

class WebhookDispatchService {
  private static instance: WebhookDispatchService | null = null;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  // Ends a sweep that is still draining when the process is shutting down.
  private stopping = false;

  // Success records still retrying after the batch moved on; shutdown waits.
  private readonly pendingRecords = new Set<Promise<void>>();

  private dispatcher: Dispatcher;
  private fetchImpl: typeof undiciFetch;

  /**
   * Who decides whether a destination may be reached.
   *
   * Injectable, and with the right value by default. The alternative would be
   * an environment variable that turns the check off in tests — and a flag
   * that disables an SSRF defence is a flag somebody eventually turns on in
   * production. Here, anybody who wants a permissive verifier has to build the
   * instance saying so, in the test file, where it can be read.
   */
  constructor(
    private verifyDestination: (
      url: string,
    ) => Promise<{
      allowed: boolean;
      reason?: string;
      transient?: boolean;
    }> = verifyWebhookDestination,

    // The HTTP client, injectable for the same reason as the verifier: the
    // default is the guarded one, and a test that wants another says so.
    options: { dispatcher?: Dispatcher; fetchImpl?: typeof undiciFetch } = {},
  ) {
    this.dispatcher = options.dispatcher ?? webhookAgent;
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
  }

  static getInstance(): WebhookDispatchService {
    WebhookDispatchService.instance ??= new WebhookDispatchService();

    return WebhookDispatchService.instance;
  }

  async initialize(): Promise<void> {
    this.stopping = false;

    this.timer = setInterval(() => {
      this.processBatch().catch((error) => {
        log.error({ err: error }, "webhook dispatch cycle failed");
      });
    }, SWEEP_INTERVAL_MS);

    // Drain whatever accumulated while the API was down, instead of making the
    // first sweep wait a full interval.
    void this.processBatch().catch((error) => {
      log.error({ err: error }, "webhook initial drain failed");
    });

    log.info("webhook dispatch worker started");
  }

  async shutdown(): Promise<void> {
    this.stopping = true;

    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    // Let the sends in flight finish and be recorded. Returning at once cut
    // every deploy between the customer's answer and our record of it, and
    // each of those went out again when the lease expired. Rows of the batch
    // that had not started are handed back instead of sent (see `release`),
    // so one call timeout bounds the wait; the deadline is the backstop, and
    // fits ADR 0004's watchdog with the workers stopping in parallel.
    const deadline = Date.now() + WEBHOOK_TIMEOUT_MS + 2_000;

    while (
      (this.running || this.pendingRecords.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    log.info("webhook dispatch worker stopped");
  }

  async processBatch(): Promise<number> {
    // One batch at a time in this process. Other replicas claim their own
    // rows — the lock is in the database, not here.
    if (this.running) return 0;

    this.running = true;

    // A hung await here keeps the flag set forever; the beats make that
    // visible on /health/metrics (OBS-10).
    workerHeartbeat.beginCycle("webhook-dispatch");

    const started = Date.now();
    let total = 0;

    try {
      // Keep claiming while there is work, within a budget: a backlog drains
      // at the speed the receivers answer, not twenty rows per sweep.
      while (!this.stopping) {
        const claimed = await this.claim();

        workerHeartbeat.progress("webhook-dispatch");

        if (claimed.length === 0) break;

        await inFairPool(
          claimed,
          {
            concurrency: WEBHOOK_CONCURRENCY,
            perKey: WEBHOOK_PER_ENDPOINT_CONCURRENCY,
            keyOf: (row) => row.endpointId,
          },
          (row) =>
            // Once the process is going away, a row not yet started is
            // handed back rather than sent: the drain waits for the calls in
            // flight, not for the rest of the batch.
            (this.stopping ? this.release(row) : this.deliver(row)).catch(
              (error) => {
                // The row keeps its lease and is reclaimed when it expires.
                log.error(
                  { err: error, deliveryId: row.id, endpointId: row.endpointId },
                  "webhook delivery failed; the lease will recover it",
                );
              },
            ),
        );

        total += claimed.length;

        if (Date.now() - started >= WEBHOOK_DRAIN_BUDGET_MS) break;
      }

      return total;
    } finally {
      this.running = false;
      workerHeartbeat.endCycle("webhook-dispatch");
    }
  }

  private async claim(): Promise<ClaimedWebhook[]> {
    // A row whose last attempt died with the process and has no attempt left
    // is closed here, with the reason, instead of being claimed again — see
    // WEBHOOK_MAX_ATTEMPTS.
    await database.$executeRaw`
      UPDATE "webhook_delivery" SET
        "status" = 'FAILED',
        "leaseExpiresAt" = NULL,
        "lastError" = 'O processo foi interrompido durante a última tentativa permitida.'
      WHERE "status" = 'PROCESSING'
        AND "availableAt" <= now()
        AND "leaseExpiresAt" < now()
        AND "attempts" >= ${WEBHOOK_MAX_ATTEMPTS}
    `;

    const claimStartedAtMs = Date.now();

    // The lease end goes into availableAt too (same expression, same
    // statement, so the two are equal): a row in flight leaves the claim's
    // range until its lease runs out, and the scan never visits it.
    const claimed = await database.$queryRaw<ClaimedWebhook[]>`
      UPDATE "webhook_delivery" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${WEBHOOK_LEASE_SECONDS}),
        "availableAt" = now() + make_interval(secs => ${WEBHOOK_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "webhook_delivery"
        WHERE "id" IN (
          -- The oldest due rows, at most WEBHOOK_PER_ENDPOINT_BATCH of any one
          -- endpoint: one slow or flooded customer cannot fill the batch.
          --
          -- Ties on "availableAt" broken by "id": the rows of one transaction
          -- share its now(), and uuid v7 ids grow in creation order — without
          -- it, which events of a transaction went first was up to the plan.
          SELECT "id" FROM (
            SELECT "id", "availableAt",
                   row_number() OVER (
                     PARTITION BY "endpointId" ORDER BY "availableAt", "id"
                   ) AS "position"
            FROM (
              SELECT "id", "endpointId", "availableAt"
              FROM "webhook_delivery"
              -- A range on the index key, so the scan stops at now(): rows
              -- held for a switched-off endpoint (availableAt up to 30 days
              -- ahead) and rows in backoff are never visited. A PROCESSING
              -- row carries its lease end there, so one in flight is out of
              -- the range and one whose lease ran out is back in it. The
              -- lease check stays for rows an older release claimed without
              -- moving availableAt.
              WHERE "availableAt" <= now()
                AND ("status" = 'PENDING'
                  OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now()
                      AND "attempts" < ${WEBHOOK_MAX_ATTEMPTS}))
              ORDER BY "availableAt", "id"
              LIMIT ${WEBHOOK_CLAIM_WINDOW}
            ) AS "head"
          ) AS "ranked"
          WHERE "position" <= ${WEBHOOK_PER_ENDPOINT_BATCH}
          ORDER BY "availableAt", "id"
          LIMIT ${BATCH_SIZE}
        )
          -- Checked again under the lock: another replica may have taken it.
          AND (("status" = 'PENDING' AND "availableAt" <= now())
            OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now()
                AND "attempts" < ${WEBHOOK_MAX_ATTEMPTS}))
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "endpointId", "topic", "payload", "attempts", "created_at"
    `;

    for (const row of claimed) row.claimStartedAtMs = claimStartedAtMs;

    return claimed;
  }

  private async deliver(row: ClaimedWebhook): Promise<void> {
    const endpoint = await database.webhookEndpoint.findUnique({
      where: { id: row.endpointId },
    });

    if (!endpoint) {
      await this.markFailed(row, null, "Endpoint no longer exists");
      return;
    }

    // Past the replay window nothing is sent, whatever the endpoint's state:
    // only a row held for a switched-off endpoint gets this old, and one whose
    // endpoint came back after the hold ran out must not deliver a month-old
    // fact as if it were news. Closed without a call, and not counted against
    // the endpoint.
    if (isOutsideReplayWindow(row.created_at)) {
      await this.markFailed(row, null, REPLAY_WINDOW_EXPIRED_REASON, {
        countFailure: false,
      });

      return;
    }

    // Paused by the customer or switched off by the breaker: nothing leaves.
    // The rows already queued used to keep going out — to a URL the customer
    // had just stopped trusting, or at ten seconds a row to one our breaker
    // had just given up on. No DNS, no fetch, no failure counted: the row is
    // held for the endpoint's return, within the replay window.
    if (!endpoint.is_active || endpoint.disabled_at !== null) {
      await this.park(row);
      return;
    }

    const stored = await database.webhookDelivery.findUnique({
      where: { id: row.id },
      select: {
        payload: true,
        signature: true,
        signed_body: true,
        sourceEventId: true,
      },
    });

    // The bytes that were signed, read back verbatim. A retry three hours
    // later posts the same body with the same signature, so a receiver that
    // logged the first attempt can prove the second is the same event.
    //
    // The fallback is for rows queued before `signed_body` existed, and it is
    // wrong in the way that column was added to fix: JSONB reorders keys, so
    // the bytes will not match the signature. Losing the event entirely would
    // be worse.
    const body = stored?.signed_body ?? JSON.stringify(stored?.payload ?? row.payload);

    /**
     * Where this may go, decided on EVERY send.
     *
     * A customer registers the URL of their own system and our server does the
     * POST — which is, literally, "ask your server to fetch this address".
     * With no brake the address can be the platform's internal network: an
     * administrator at any carrier would point an endpoint at
     * `169.254.169.254` and read the instance credentials through the monitor
     * itself, which hands them the response body.
     *
     * On every send and not only at registration: a name that resolved to a
     * public address when it was saved can start resolving to a private one.
     */
    const destination = await this.verifyDestination(endpoint.url);

    if (!destination.allowed) {
      // Could not be resolved right now: a network failure like any other,
      // retried on the schedule. Only a destination that resolved somewhere
      // forbidden is refused for good.
      if (destination.transient) {
        await this.scheduleRetry(
          row,
          { status: null, body: "", latency: null },
          destination.reason ?? UNRESOLVED_REASON,
        );

        return;
      }

      await this.markFailed(
        row,
        null,
        destination.reason ?? "Destino não permitido.",
        { permanent: true },
      );

      return;
    }

    /**
     * Signed NOW, over the exact bytes about to be sent.
     *
     * The signature used to be computed once, at fan-out, and resent unchanged
     * on every attempt. It carries a timestamp, and the verification our own
     * documentation tells receivers to implement refuses one older than five
     * minutes — so every retry after the third, every event that waited in
     * the queue for more than five minutes and every manual resend reached the
     * customer with a signature they were right to reject. The body does not
     * change between attempts; only the moment it vouches for does.
     *
     * The secret is sealed at rest (secret-box). During a rotation the one it
     * replaced signs too, as a second `v1`, until its grace period ends — the
     * receiver may still be holding it.
     */
    const rotating =
      endpoint.previous_secret !== null &&
      endpoint.previous_secret_expires_at !== null &&
      endpoint.previous_secret_expires_at > new Date();

    // Opened here, outside the network `try` below: a value that cannot be
    // opened (WEBHOOK_SECRETS_KEY missing or wrong) is OUR fault, not the
    // receiver's, and never counts against the customer's endpoint. It used
    // to throw and leave the row to its lease — reclaimed every two minutes,
    // the whole retry budget gone in a quarter of an hour, and the row closed
    // as an interrupted process. It follows the retry schedule instead, with
    // the reason, so a key fixed within the documented window still delivers.
    let signed: ReturnType<typeof signWebhookPayload>;
    let customerHeaders: Record<string, string>;

    try {
      signed = signWebhookPayload(
        openSecret(endpoint.secret),
        body,
        new Date(),
        rotating ? previousSecretOf(endpoint.previous_secret!) : [],
      );

      customerHeaders = safeWebhookHeaders(openHeaders(endpoint.headers));
    } catch (error) {
      // The message only: the sealed secret and headers stay out of the log.
      log.error(
        { endpointId: endpoint.id, error: (error as Error).message },
        "webhook endpoint credentials unreadable",
      );

      await this.scheduleRetry(
        row,
        { status: null, body: "", latency: null },
        CREDENTIALS_UNREADABLE_REASON,
        { countFailure: false },
      );

      return;
    }

    const startedAt = Date.now();

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    // What their server answered. Only the network is inside the `try`: a
    // database write that failed after a 200 used to land in its `catch`,
    // which scheduled a retry of an event the customer had already accepted.
    let answer: { status: number; text: string; latency: number };

    try {
      const response = await this.fetchImpl(endpoint.url, {
        // Connects only to an address the guarded lookup validated: the
        // check above cannot be walked around by a name that answers
        // differently a moment later.
        dispatcher: this.dispatcher,

        // No redirects. The `https://` from registration only covers the
        // first hop, and a 302 to `http://169.254.169.254` would void the
        // whole check above. A webhook receiver has no legitimate reason to
        // redirect.
        redirect: "manual",

        method: "POST",
        headers: {
          // The customer's FIRST, ours after.
          //
          // The other way round, a customer would overwrite
          // `X-Trajetto-Signature` — the guarantee the public documentation
          // promises — and turn a shared receiver into a replay target.
          // `safeWebhookHeaders` already strips the reserved ones; the
          // ordering is the second lock.
          ...customerHeaders,

          "Content-Type": "application/json",
          "User-Agent": "Trajetto-Webhooks/1.0",

          // Asked, not relied on: a server can compress anyway, and the read
          // below is capped in decompressed bytes either way.
          "Accept-Encoding": "identity",

          "X-Trajetto-Topic": row.topic,

          // The event, stable across retries and manual resends: what a
          // receiver deduplicates on. A row queued before the id existed
          // falls back to its own id, which its resend inherits.
          "X-Trajetto-Event-Id": stored?.sourceEventId ?? row.id,

          // The attempt row: changes on a manual resend. For support, not
          // for deduplication.
          "X-Trajetto-Delivery": row.id,
          "X-Trajetto-Signature": signed.header,
        },
        body,
        signal: controller.signal,
      });

      const latency = Date.now() - startedAt;

      // A 3xx with `redirect: "manual"` comes back as an ordinary response;
      // its body is not kept (see below), only released.
      const redirected = response.status >= 300 && response.status < 400;

      // Read before deciding: a 500 with a body saying what went wrong is the
      // single most useful thing a customer's engineer can be shown.
      //
      // Bounded: only the first few kilobytes are ever read — see
      // readBoundedBody for what reading all of it cost.
      const text = await readBoundedBody(
        response,
        redirected ? 0 : RESPONSE_READ_LIMIT_BYTES,
      ).catch(() => "");

      answer = { status: response.status, text, latency };

      // Per-channel latency and error rate on /health/metrics: the status
      // only, the customer's body never leaves the monitor.
      providerMetrics.record(
        "WEBHOOK",
        latency,
        isWebhookSuccess(response.status),
        `http_${response.status}`,
      );
    } catch (error) {
      const code = (error as { cause?: { code?: string } } | null)?.cause?.code;

      providerMetrics.record(
        "WEBHOOK",
        Date.now() - startedAt,
        false,
        controller.signal.aborted
          ? "timeout"
          : code === "EWEBHOOK_FORBIDDEN"
            ? "forbidden"
            : code === "EWEBHOOK_UNRESOLVED"
              ? "unresolved"
              : "network",
      );

      // The name now points somewhere private: rebinding, or a record the
      // customer changed. Refused for good, exactly like the check above.
      if (code === "EWEBHOOK_FORBIDDEN") {
        await this.markFailed(row, null, UNREACHABLE_REASON, { permanent: true });
        return;
      }

      const message = controller.signal.aborted
        ? `O endpoint não respondeu em ${WEBHOOK_TIMEOUT_MS}ms.`
        : code === "EWEBHOOK_UNRESOLVED"
          ? UNRESOLVED_REASON
          : networkFailureReason(error);

      // No latency and no raw error: see networkFailureReason.
      await this.scheduleRetry(
        row,
        { status: null, body: "", latency: null },
        message,
      );

      return;
    } finally {
      clearTimeout(timer);
    }

    if (isWebhookSuccess(answer.status)) {
      await this.settleSuccess(row, answer);
      return;
    }

    // Counting a redirect as a success would claim the event reached a place
    // it was never sent to.
    if (answer.status >= 300 && answer.status < 400) {
      await this.markFailed(
        row,
        { status: answer.status, body: "", latency: answer.latency },
        "O endpoint respondeu com um redirecionamento, que não é seguido.",
        { permanent: true },
      );

      return;
    }

    // 410 Gone is a receiver saying "stop sending me this", and honouring it
    // is the difference between an integration and a nuisance.
    if (isWebhookPermanent(answer.status)) {
      await this.markFailed(
        row,
        { status: answer.status, body: answer.text, latency: answer.latency },
        "O endpoint respondeu 410 Gone: parou de aceitar este evento.",
        { permanent: true },
      );

      return;
    }

    await this.scheduleRetry(
      row,
      { status: answer.status, body: answer.text, latency: answer.latency },
      `O endpoint respondeu ${answer.status}.`,
    );
  }

  /**
   * The row as this worker claimed it. Every write that settles a delivery is
   * conditioned on it: once the lease ran out and another replica reclaimed
   * the row, `attempts` moved on, the write matches nothing, and this worker
   * can no longer overwrite what the new owner decided. A PENDING written over
   * a DELIVERED was a third copy of the event, and a failure counted against
   * an endpoint that had just answered 200. Same rule as the notification
   * pipeline's `fenced`.
   */
  private fenced(row: ClaimedWebhook) {
    return {
      id: row.id,
      status: WebhookDeliveryStatus.PROCESSING,
      attempts: row.attempts,
    };
  }

  /**
   * Holds a row of an endpoint that may not be delivered to, until the end of
   * its replay window or until the endpoint is saved again
   * (`releaseParkedWebhookDeliveries`). The claim was not an attempt, so it
   * is given back; a row in backoff resumes its schedule afterwards.
   */
  private async park(row: ClaimedWebhook): Promise<void> {
    const { count } = await database.webhookDelivery.updateMany({
      where: this.fenced(row),
      data: {
        status: WebhookDeliveryStatus.PENDING,
        attempts: row.attempts - 1,
        availableAt: parkedUntil(row.created_at),
        leaseExpiresAt: null,
        lastError: ENDPOINT_PAUSED_REASON,
      },
    });

    // The endpoint was read before this write, and a save in between released
    // everything but this row, which was still in flight.
    if (count === 1) await releaseHeldRowIfEndpointBack(row.id, row.endpointId);
  }

  /**
   * Hands an unstarted row back, on shutdown: the claim was not an attempt.
   */
  private async release(row: ClaimedWebhook): Promise<void> {
    await database.webhookDelivery.updateMany({
      where: this.fenced(row),
      data: {
        status: WebhookDeliveryStatus.PENDING,
        attempts: row.attempts - 1,
        availableAt: new Date(),
        leaseExpiresAt: null,
      },
    });
  }

  /**
   * Records a send the receiver accepted.
   *
   * Never falls back to a retry of the SEND: the customer already has the
   * event. The write is retried — detached once the quick retries run out —
   * until shortly before this claim's lease ends (see
   * shared/resilience/record-accepted-outcome.ts); only an outage longer
   * than that leaves the row to its lease, and another replica sends it
   * again under the same event id, which receivers deduplicate by.
   */
  private async settleSuccess(
    row: ClaimedWebhook,
    answer: { status: number; text: string; latency: number },
  ): Promise<void> {
    const fields = { deliveryId: row.id, endpointId: row.endpointId };

    await recordAcceptedOutcome({
      deadline: recordDeadline(
        row.claimStartedAtMs ?? Date.now(),
        WEBHOOK_LEASE_SECONDS,
      ),
      write: () =>
        this.markDelivered(row, answer.status, answer.text, answer.latency),
      onDetached: (error) => {
        log.warn(
          { ...fields, err: error },
          "webhook delivery ACCEPTED but not yet recorded; retrying the record until the lease is about to end",
        );
      },
      onGiveUp: (error) => {
        log.error(
          { ...fields, err: error },
          "webhook delivery ACCEPTED by the endpoint but not recorded; it goes out again when the lease expires",
        );
      },
      track: (pending) => {
        this.pendingRecords.add(pending);
        void pending.finally(() => this.pendingRecords.delete(pending));
      },
    });
  }

  private async markDelivered(
    row: ClaimedWebhook,
    status: number,
    body: string,
    latency: number,
  ): Promise<void> {
    const { count } = await database.webhookDelivery.updateMany({
      where: this.fenced(row),
      data: {
        status: WebhookDeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
        response_status: status,
        response_body: truncateResponseBody(body),
        latency_ms: latency,
        lastError: null,
        leaseExpiresAt: null,
      },
    });

    // Another replica owns the row now; its outcome stands.
    if (count === 0) return;

    // One success clears the streak. An endpoint that fails nineteen times
    // and then works is a flaky endpoint, not a dead one.
    await database.webhookEndpoint.update({
      where: { id: row.endpointId },
      data: { consecutive_failures: 0 },
    });
  }

  private async scheduleRetry(
    row: ClaimedWebhook,
    attempt: { status: number | null; body: string; latency: number | null },
    message: string,

    /** false: the attempt never reached the receiver through its fault. */
    options: { countFailure?: boolean } = {},
  ): Promise<void> {
    const baseDelay = nextWebhookDelayMs(row.attempts);

    if (baseDelay === null) {
      await this.markFailed(row, attempt, message, options);
      return;
    }

    const { count } = await database.webhookDelivery.updateMany({
      where: this.fenced(row),
      data: {
        status: WebhookDeliveryStatus.PENDING,

        // Jittered, so a customer's endpoint coming back up is not hit by
        // every queued event of the outage in the same millisecond.
        availableAt: new Date(Date.now() + withRetryJitter(baseDelay)),

        leaseExpiresAt: null,
        response_status: attempt.status,
        response_body: truncateResponseBody(attempt.body),
        latency_ms: attempt.latency,
        lastError: message,
      },
    });

    // Lost the lease: the failure is not ours to count — see `fenced`.
    if (count === 0) return;

    if (options.countFailure === false) return;

    await this.countFailure(row.endpointId);
  }

  private async markFailed(
    row: ClaimedWebhook,
    attempt: {
      status: number | null;
      body: string;
      latency: number | null;
    } | null,
    message: string,
    options: { permanent?: boolean; countFailure?: boolean } = {},
  ): Promise<void> {
    const { count } = await database.webhookDelivery.updateMany({
      where: this.fenced(row),
      data: {
        status: WebhookDeliveryStatus.FAILED,
        leaseExpiresAt: null,
        response_status: attempt?.status ?? null,
        response_body: attempt ? truncateResponseBody(attempt.body) : null,
        latency_ms: attempt?.latency ?? null,
        lastError: message,
      },
    });

    // Lost the lease (or the endpoint and its rows are gone): the verdict,
    // and whatever it would do to the endpoint, belong to the new owner.
    if (count === 0) return;

    if (options.permanent) {
      await this.disableEndpoint(row.endpointId, message);
      return;
    }

    // A row closed without a call (the window ran out while the endpoint was
    // off) says nothing about the endpoint's health.
    if (options.countFailure === false) return;

    await this.countFailure(row.endpointId);
  }

  /**
   * Switches an endpoint off, and tells the company — once.
   *
   * The switch-off used to be silent: the customer found out their ERP had
   * stopped receiving events when a reconciliation failed to close. Now the
   * company's admins get a notice through the pipeline, in the same
   * transaction as the switch. `disabled_at: null` in the condition makes
   * concurrent failures (several rows of one endpoint failing at once, on
   * several replicas) publish a single notice.
   */
  private async disableEndpoint(endpointId: string, reason: string): Promise<void> {
    const disabledAt = new Date();

    await database.$transaction(async (tx) => {
      const { count } = await tx.webhookEndpoint.updateMany({
        where: { id: endpointId, disabled_at: null },
        data: { disabled_at: disabledAt },
      });

      if (count !== 1) return;

      const endpoint = await tx.webhookEndpoint.findUniqueOrThrow({
        where: { id: endpointId },
        select: { name: true, url: true, businessId: true },
      });

      await outbox.publish(tx, {
        topic: "webhook-endpoint.disabled",
        aggregateType: "WebhookEndpoint",
        aggregateId: endpointId,
        businessId: endpoint.businessId,
        eventKey: `webhook-endpoint.disabled:${endpointId}:${disabledAt.toISOString()}`,
        payload: {
          businessId: endpoint.businessId,
          endpointId,
          endpointName: endpoint.name,
          url: endpoint.url,
          reason,
          disabledAt: disabledAt.toISOString(),
        },
      });
    });
  }

  /**
   * Counts a failure, and switches the endpoint off once there have been too
   * many in a row.
   *
   * A dead URL costs every single event a ten-second timeout, which at a
   * hundred events an hour is a worker doing nothing else. Turning it off is
   * ours to do; the customer's own `is_active` switch is separate, and turning
   * it back on is a deliberate act by somebody who fixed the endpoint.
   */
  private async countFailure(endpointId: string): Promise<void> {
    const updated = await database.webhookEndpoint.update({
      where: { id: endpointId },
      data: { consecutive_failures: { increment: 1 } },
      select: { consecutive_failures: true, disabled_at: true },
    });

    if (
      updated.disabled_at === null &&
      updated.consecutive_failures >= MAX_CONSECUTIVE_FAILURES
    ) {
      await this.disableEndpoint(
        endpointId,
        `${MAX_CONSECUTIVE_FAILURES} falhas seguidas.`,
      );
    }
  }
}

const webhookDispatchService = WebhookDispatchService.getInstance();

export {
  WebhookDispatchService,
  fanOutWebhookEvent,
  releaseHeldRowIfEndpointBack,
  releaseParkedWebhookDeliveries,
  webhookDispatchService,
};
export type { FanOutEvent };
