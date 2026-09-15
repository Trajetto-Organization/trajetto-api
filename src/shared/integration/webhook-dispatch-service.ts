import database from "@/../infra/database";

import { Prisma, WebhookDeliveryStatus } from "@prisma/client";

import {
  MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_TIMEOUT_MS,
  assertWebhookLeaseInvariant,
  isWebhookPermanent,
  isWebhookSuccess,
  nextWebhookDelayMs,
  truncateResponseBody,
} from "./webhook-dispatch-rules";

import { signWebhookPayload } from "./webhook-signature";
import { endpointWantsTopic } from "./webhook-catalogue";

import { withRetryJitter } from "@/shared/notifications/pipeline-rules";

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
}

interface FanOutEvent {
  topic: string;
  businessId: string;

  /** The outbox row this came from, for tracing one fact across both queues. */
  sourceEventId?: string | null;

  payload: Record<string, unknown>;
}

/**
 * Turns one domain event into one row per interested endpoint.
 *
 * Signed HERE, at fan-out, and not at send time. The signature covers the
 * exact bytes that will be posted, so a retry three hours later sends the same
 * body with the same signature — a receiver that logged the first attempt can
 * prove the second is the same event, and we cannot accidentally re-sign a
 * payload that drifted.
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

  const endpoints = await client.webhookEndpoint.findMany({
    where: {
      businessId: event.businessId,
      is_active: true,
      disabled_at: null,
    },
  });

  const interested = endpoints.filter((endpoint) =>
    endpointWantsTopic(endpoint.topics, event.topic),
  );

  if (interested.length === 0) return 0;

  const body = JSON.stringify({
    id: event.sourceEventId ?? undefined,
    topic: event.topic,
    created_at: new Date().toISOString(),
    data: event.payload,
  });

  const rows = interested.map((endpoint) => {
    const signed = signWebhookPayload(endpoint.secret, body);

    return {
      endpointId: endpoint.id,
      businessId: event.businessId,
      topic: event.topic,
      sourceEventId: event.sourceEventId ?? null,

      // The queryable copy, for the monitor and for anybody asking what was
      // sent. NOT what goes on the wire — see `signed_body`.
      payload: JSON.parse(body) as Prisma.InputJsonValue,

      // What goes on the wire, byte for byte. JSONB is not a string: Postgres
      // parses it, reorders the keys and drops duplicates, so re-serialising
      // the column at send time produces a body the signature does not cover.
      // The receiver rejects it, and nothing on our side can tell — from here
      // the POST returned 200.
      signed_body: body,

      signature: signed.header,
    };
  });

  await client.webhookDelivery.createMany({ data: rows });

  return rows.length;
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

  static getInstance(): WebhookDispatchService {
    WebhookDispatchService.instance ??= new WebhookDispatchService();

    return WebhookDispatchService.instance;
  }

  async initialize(): Promise<void> {
    this.timer = setInterval(() => {
      this.processBatch().catch((error) => {
        console.error("[WebhookDispatch] Cycle error:", error);
      });
    }, SWEEP_INTERVAL_MS);

    // Drain whatever accumulated while the API was down, instead of making the
    // first sweep wait a full interval.
    void this.processBatch().catch((error) => {
      console.error("[WebhookDispatch] Initial drain error:", error);
    });

    console.log("[WebhookDispatch] Worker iniciado");
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    // A batch in flight keeps its lease and is reclaimed by whoever is up
    // next; there is nothing to wait for here that waiting would improve.
    console.log("[WebhookDispatch] Worker encerrado");
  }

  async processBatch(): Promise<number> {
    // One batch at a time in this process. Other replicas claim their own
    // rows — the lock is in the database, not here.
    if (this.running) return 0;

    this.running = true;

    try {
      const claimed = await this.claim();

      if (claimed.length === 0) return 0;

      for (let index = 0; index < claimed.length; index += WEBHOOK_CONCURRENCY) {
        const wave = claimed.slice(index, index + WEBHOOK_CONCURRENCY);

        await Promise.all(wave.map((row) => this.deliver(row)));
      }

      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<ClaimedWebhook[]> {
    return database.$queryRaw<ClaimedWebhook[]>`
      UPDATE "webhook_delivery" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${WEBHOOK_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "webhook_delivery"
        WHERE ("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now())
        ORDER BY "availableAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "endpointId", "topic", "payload", "attempts"
    `;
  }

  private async deliver(row: ClaimedWebhook): Promise<void> {
    const endpoint = await database.webhookEndpoint.findUnique({
      where: { id: row.endpointId },
    });

    if (!endpoint) {
      await this.markFailed(row, null, "Endpoint no longer exists");
      return;
    }

    const stored = await database.webhookDelivery.findUnique({
      where: { id: row.id },
      select: { payload: true, signature: true, signed_body: true },
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

    const startedAt = Date.now();

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Trajetto-Webhooks/1.0",

          "X-Trajetto-Topic": row.topic,
          "X-Trajetto-Delivery": row.id,
          "X-Trajetto-Signature": stored?.signature ?? "",

          ...((endpoint.headers as Record<string, string> | null) ?? {}),
        },
        body,
        signal: controller.signal,
      });

      const latency = Date.now() - startedAt;

      // Read before deciding: a 500 with a body saying what went wrong is the
      // single most useful thing a customer's engineer can be shown.
      const text = await response.text().catch(() => "");

      if (isWebhookSuccess(response.status)) {
        await this.markDelivered(row, response.status, text, latency);
        return;
      }

      // 410 Gone is a receiver saying "stop sending me this", and honouring it
      // is the difference between an integration and a nuisance.
      if (isWebhookPermanent(response.status)) {
        await this.markFailed(
          row,
          { status: response.status, body: text, latency },
          "O endpoint respondeu 410 Gone: parou de aceitar este evento.",
          { permanent: true },
        );

        return;
      }

      await this.scheduleRetry(
        row,
        { status: response.status, body: text, latency },
        `O endpoint respondeu ${response.status}.`,
      );
    } catch (error) {
      const latency = Date.now() - startedAt;

      const message =
        controller.signal.aborted
          ? `O endpoint não respondeu em ${WEBHOOK_TIMEOUT_MS}ms.`
          : error instanceof Error
            ? error.message
            : String(error);

      await this.scheduleRetry(row, { status: null, body: "", latency }, message);
    } finally {
      clearTimeout(timer);
    }
  }

  private async markDelivered(
    row: ClaimedWebhook,
    status: number,
    body: string,
    latency: number,
  ): Promise<void> {
    await database.$transaction([
      database.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: WebhookDeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          response_status: status,
          response_body: truncateResponseBody(body),
          latency_ms: latency,
          lastError: null,
          leaseExpiresAt: null,
        },
      }),

      // One success clears the streak. An endpoint that fails nineteen times
      // and then works is a flaky endpoint, not a dead one.
      database.webhookEndpoint.update({
        where: { id: row.endpointId },
        data: { consecutive_failures: 0 },
      }),
    ]);
  }

  private async scheduleRetry(
    row: ClaimedWebhook,
    attempt: { status: number | null; body: string; latency: number },
    message: string,
  ): Promise<void> {
    const baseDelay = nextWebhookDelayMs(row.attempts);

    if (baseDelay === null) {
      await this.markFailed(row, attempt, message);
      return;
    }

    await database.webhookDelivery.update({
      where: { id: row.id },
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

    await this.countFailure(row.endpointId);
  }

  private async markFailed(
    row: ClaimedWebhook,
    attempt: { status: number | null; body: string; latency: number } | null,
    message: string,
    options: { permanent?: boolean } = {},
  ): Promise<void> {
    await database.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        leaseExpiresAt: null,
        response_status: attempt?.status ?? null,
        response_body: attempt ? truncateResponseBody(attempt.body) : null,
        latency_ms: attempt?.latency ?? null,
        lastError: message,
      },
    });

    if (options.permanent) {
      await database.webhookEndpoint.update({
        where: { id: row.endpointId },
        data: { disabled_at: new Date() },
      });

      return;
    }

    await this.countFailure(row.endpointId);
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
      await database.webhookEndpoint.update({
        where: { id: endpointId },
        data: { disabled_at: new Date() },
      });
    }
  }
}

const webhookDispatchService = WebhookDispatchService.getInstance();

export { WebhookDispatchService, fanOutWebhookEvent, webhookDispatchService };
export type { FanOutEvent };
