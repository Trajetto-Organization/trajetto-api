import { afterAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The objects that exist only in migration SQL, exactly as they must be.
 *
 * Prisma 6.1 cannot declare a partial index, an INCLUDE, a trigram GIN or a
 * CHECK, so schema.prisma does not show them and no `migrate diff` notices
 * when one goes missing or changes shape. Each of them carries a rule the code
 * relies on without checking it again: a dedupe (`createMany({ skipDuplicates
 * })` is idempotent only while its unique index exists), an invariant (one
 * recipient per delivery, one open stop per delivery, one route in progress
 * per vehicle), or a claim that stops reading at now() instead of walking a
 * whole queue. A hand-written migration, a DROP COLUMN that cascades, or a
 * future Prisma that starts modelling partial indexes can each take one away
 * with every other test still green.
 *
 * So each is pinned here by name and by its full definition as Postgres
 * prints it — key columns, predicate, INCLUDE — and anything of the same kind
 * that appears without being listed fails too, so the next one gets pinned
 * when it is written.
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/** `pg_get_indexdef`, schema-qualified as Postgres prints it. */
const INDEXES: Record<string, string> = {
  // Queue claims: a range on the key under a partial predicate.
  ai_analysis_request_claim_idx: `CREATE INDEX ai_analysis_request_claim_idx ON public.ai_analysis_request USING btree (created_at) WHERE (status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"]))`,
  ai_analysis_request_fair_claim_idx: `CREATE INDEX ai_analysis_request_fair_claim_idx ON public.ai_analysis_request USING btree ("businessId", created_at) WHERE (status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"]))`,
  domain_outbox_event_claim_idx: `CREATE INDEX domain_outbox_event_claim_idx ON public.domain_outbox_event USING btree (created_at) WHERE (status = ANY (ARRAY['PENDING'::"OutboxEventStatus", 'PROCESSING'::"OutboxEventStatus"]))`,
  notification_delivery_claim_internal_idx: `CREATE INDEX notification_delivery_claim_internal_idx ON public.notification_delivery USING btree ("availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['IN_APP'::"NotificationChannel", 'ACTIVITY'::"NotificationChannel", 'PUSH'::"NotificationChannel"])))`,
  notification_delivery_claim_external_idx: `CREATE INDEX notification_delivery_claim_external_idx ON public.notification_delivery USING btree ("availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['EMAIL'::"NotificationChannel", 'WHATSAPP'::"NotificationChannel"])))`,
  webhook_delivery_claim_idx: `CREATE INDEX webhook_delivery_claim_idx ON public.webhook_delivery USING btree ("availableAt") WHERE (status = ANY (ARRAY['PENDING'::"WebhookDeliveryStatus", 'PROCESSING'::"WebhookDeliveryStatus"]))`,
  delivery_proof_audit_queue_idx: `CREATE INDEX delivery_proof_audit_queue_idx ON public.delivery_proof_audit USING btree ("businessId", created_at) WHERE (status = 'PENDING'::"ProofAuditStatus")`,
  // The abandoned-import sweep: only the uploads running right now (IDEMP-10).
  import_in_progress_heartbeat_idx: `CREATE INDEX import_in_progress_heartbeat_idx ON public.import USING btree (updated_at) WHERE (status = 'IN_PROGRESS'::"ImportStatus")`,
  // The tower's authorization queue and the 10-minute escalation sweep:
  // only what still waits (decision 6.3).
  delivery_occurrence_pending_authorization_idx: `CREATE INDEX delivery_occurrence_pending_authorization_idx ON public.delivery_occurrence USING btree ("businessId", created_at) WHERE (authorization_status = 'PENDING'::"OccurrenceAuthorizationStatus")`,

  // Dedupe: the unique keys `createMany({ skipDuplicates })` leans on.
  notification_delivery_user_event_channel_idx: `CREATE UNIQUE INDEX notification_delivery_user_event_channel_idx ON public.notification_delivery USING btree ("outboxEventId", "userId", channel) WHERE ("userId" IS NOT NULL)`,
  notification_delivery_external_event_channel_idx: `CREATE UNIQUE INDEX notification_delivery_external_event_channel_idx ON public.notification_delivery USING btree ("outboxEventId", "externalRecipientId", channel) WHERE ("externalRecipientId" IS NOT NULL)`,

  // Invariants no code path checks before writing: the P2002 IS the check.
  route_stop_active_delivery_idx: `CREATE UNIQUE INDEX route_stop_active_delivery_idx ON public.route_stop USING btree ("deliveryId") WHERE (status = ANY (ARRAY['PENDING'::"RouteStopStatus", 'ARRIVED'::"RouteStopStatus"]))`,
  route_active_vehicle_idx: `CREATE UNIQUE INDEX route_active_vehicle_idx ON public.route USING btree ("vehicleId") WHERE (status = 'IN_PROGRESS'::"RouteStatus")`,
  // One open pause per driver: a second "start" is a P2002, not a second
  // clock running (decision 6.1).
  driver_pause_one_open_idx: `CREATE UNIQUE INDEX driver_pause_one_open_idx ON public.driver_pause USING btree ("driverId") WHERE (ended_at IS NULL)`,
  // One OPEN ticket per delivery and per route (decision 14.5): two openings
  // at once on two replicas converge on one ticket through P2002 + re-read.
  support_ticket_open_delivery_uq: `CREATE UNIQUE INDEX support_ticket_open_delivery_uq ON public.support_ticket USING btree ("deliveryId") WHERE ((status = 'OPEN'::"SupportTicketStatus") AND (kind = 'DELIVERY'::"SupportTicketKind"))`,
  support_ticket_open_route_uq: `CREATE UNIQUE INDEX support_ticket_open_route_uq ON public.support_ticket USING btree ("routeId") WHERE ((status = 'OPEN'::"SupportTicketStatus") AND (kind = 'ROUTE'::"SupportTicketKind"))`,

  // Reads that stay proportional to what they return.
  delivery_delivered_today_idx: `CREATE INDEX delivery_delivered_today_idx ON public.delivery USING btree ("businessId", delivered_at) INCLUDE ("driverId") WHERE (status = 'DELIVERED'::"DeliveryStatus")`,
  delivery_failed_recent_idx: `CREATE INDEX delivery_failed_recent_idx ON public.delivery USING btree ("businessId", updated_at) INCLUDE ("driverId") WHERE (status = 'FAILED'::"DeliveryStatus")`,
  notification_delivery_failed_idx: `CREATE INDEX notification_delivery_failed_idx ON public.notification_delivery USING btree (updated_at, channel) WHERE (status = 'FAILED'::"NotificationDeliveryStatus")`,
  webhook_delivery_failed_idx: `CREATE INDEX webhook_delivery_failed_idx ON public.webhook_delivery USING btree (updated_at) WHERE (status = 'FAILED'::"WebhookDeliveryStatus")`,
  webhook_delivery_purge_idx: `CREATE INDEX webhook_delivery_purge_idx ON public.webhook_delivery USING btree (created_at) WHERE (status = ANY (ARRAY['DELIVERED'::"WebhookDeliveryStatus", 'FAILED'::"WebhookDeliveryStatus"]))`,
  // The nightly purge of PUBLISHED outbox events, batched by processedAt
  // (publishedPurgeBatchSql; the plan is pinned in notification-purge-plan).
  domain_outbox_event_published_processed_idx: `CREATE INDEX domain_outbox_event_published_processed_idx ON public.domain_outbox_event USING btree ("processedAt") WHERE (status = 'PUBLISHED'::"OutboxEventStatus")`,
  // The tickets list's "Meus" and "Sem atendente", and the alert balloon's
  // summary: only what is still open (decision 14.5).
  support_ticket_open_assignee_idx: `CREATE INDEX support_ticket_open_assignee_idx ON public.support_ticket USING btree ("assigneeId", last_message_at DESC) WHERE ((status = 'OPEN'::"SupportTicketStatus") AND ("assigneeId" IS NOT NULL))`,
  support_ticket_open_unassigned_idx: `CREATE INDEX support_ticket_open_unassigned_idx ON public.support_ticket USING btree ("businessId", created_at) WHERE ((status = 'OPEN'::"SupportTicketStatus") AND ("assigneeId" IS NULL))`,
  // The inbox's "Encerrados" and "Todos" in their NULLS LAST order, which
  // schema.prisma cannot declare (db-perf 10/2026,
  // migration 20261007120000_db_perf_indexes).
  support_ticket_closed_inbox_idx: `CREATE INDEX support_ticket_closed_inbox_idx ON public.support_ticket USING btree ("businessId", status, closed_at DESC NULLS LAST, id DESC)`,
  support_ticket_all_inbox_idx: `CREATE INDEX support_ticket_all_inbox_idx ON public.support_ticket USING btree ("businessId", last_message_at DESC NULLS LAST, created_at DESC, id DESC)`,
  // The deliveries search's trigram read: the expression must stay the one
  // DELIVERY_SEARCH_TEXT sends (delivery-search.ts), or the planner ignores it.
  delivery_search_trgm_idx: `CREATE INDEX delivery_search_trgm_idx ON public.delivery USING gin (lower(((((((((((id || chr(31)) || COALESCE(code, ''::text)) || chr(31)) || COALESCE(invoice_key, ''::text)) || chr(31)) || COALESCE(invoice_number, ''::text)) || chr(31)) || recipient_name) || chr(31)) || city)) gin_trgm_ops)`,
  chat_message_body_trgm_idx: `CREATE INDEX chat_message_body_trgm_idx ON public.chat_message USING gin (body gin_trgm_ops)`,
  // The case-insensitive e-mail lookup of the login and the password reset:
  // the expression must stay the one UserRepository.idByEmail sends.
  user_email_lower_idx: `CREATE INDEX user_email_lower_idx ON public."user" USING btree (lower(email))`,

  // Sparse foreign keys and lookups: only the rows that have a value.
  chat_message_delivery_idx: `CREATE INDEX chat_message_delivery_idx ON public.chat_message USING btree ("deliveryId") WHERE ("deliveryId" IS NOT NULL)`,
  // A route's messages in order, and the SET NULL when a route is deleted
  // (decision 6.7).
  chat_message_route_idx: `CREATE INDEX chat_message_route_idx ON public.chat_message USING btree ("routeId", created_at) WHERE ("routeId" IS NOT NULL)`,
  delivery_apiKeyId_partial_idx: `CREATE INDEX "delivery_apiKeyId_partial_idx" ON public.delivery USING btree ("apiKeyId") WHERE ("apiKeyId" IS NOT NULL)`,
  delivery_event_occurrenceId_partial_idx: `CREATE INDEX "delivery_event_occurrenceId_partial_idx" ON public.delivery_event USING btree ("occurrenceId") WHERE ("occurrenceId" IS NOT NULL)`,
  delivery_occurrence_authorizedById_partial_idx: `CREATE INDEX "delivery_occurrence_authorizedById_partial_idx" ON public.delivery_occurrence USING btree ("authorizedById") WHERE ("authorizedById" IS NOT NULL)`,
  delivery_event_reasonId_partial_idx: `CREATE INDEX "delivery_event_reasonId_partial_idx" ON public.delivery_event USING btree ("reasonId") WHERE ("reasonId" IS NOT NULL)`,
  // A delivery's and a route's tickets, and the SET NULL paths of the
  // ticket's context and people (decision 14.5).
  support_ticket_deliveryId_partial_idx: `CREATE INDEX "support_ticket_deliveryId_partial_idx" ON public.support_ticket USING btree ("deliveryId") WHERE ("deliveryId" IS NOT NULL)`,
  support_ticket_routeId_partial_idx: `CREATE INDEX "support_ticket_routeId_partial_idx" ON public.support_ticket USING btree ("routeId") WHERE ("routeId" IS NOT NULL)`,
  support_ticket_openedById_partial_idx: `CREATE INDEX "support_ticket_openedById_partial_idx" ON public.support_ticket USING btree ("openedById") WHERE ("openedById" IS NOT NULL)`,
  support_ticket_assigneeId_partial_idx: `CREATE INDEX "support_ticket_assigneeId_partial_idx" ON public.support_ticket USING btree ("assigneeId") WHERE ("assigneeId" IS NOT NULL)`,
  support_ticket_closedById_partial_idx: `CREATE INDEX "support_ticket_closedById_partial_idx" ON public.support_ticket USING btree ("closedById") WHERE ("closedById" IS NOT NULL)`,
  support_ticket_event_actorId_partial_idx: `CREATE INDEX "support_ticket_event_actorId_partial_idx" ON public.support_ticket_event USING btree ("actorId") WHERE ("actorId" IS NOT NULL)`,
  notification_delivery_providerMessageId_idx: `CREATE INDEX "notification_delivery_providerMessageId_idx" ON public.notification_delivery USING btree ("providerMessageId") WHERE ("providerMessageId" IS NOT NULL)`,
};

/** `pg_get_constraintdef` of the CHECK constraints. */
const CHECKS: Record<string, string> = {
  notification_delivery_one_recipient: `CHECK (((("userId" IS NOT NULL) AND ("externalRecipientId" IS NULL)) OR (("userId" IS NULL) AND ("externalRecipientId" IS NOT NULL))))`,
  // Occurrence categories (decisions 14.3 and 14.4): a pause type always says
  // its legal nature and only a pause type has one; only "não entrega" can
  // block; a pause asks for nothing but the tap.
  occurrence_type_pause_kind_chk: `CHECK (((category = 'PAUSE'::"OccurrenceCategory") = (pause_kind IS NOT NULL)))`,
  occurrence_type_blocks_only_not_delivered_chk: `CHECK (((category = 'NOT_DELIVERED'::"OccurrenceCategory") OR (blocks_delivery = false)))`,
  occurrence_type_pause_requirements_chk: `CHECK (((category <> 'PAUSE'::"OccurrenceCategory") OR ((requires_photo = false) AND (requires_receipt_photo = false) AND (requires_signature = false) AND (requires_authorization = false))))`,
};

type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Every index Prisma could not have created: a predicate, an expression, an
 * INCLUDE list, a trigram operator class or a NULLS LAST key.
 */
async function rawIndexes(client: Client): Promise<Map<string, string>> {
  const rows = await client.$queryRaw<
    Array<{ name: string; definition: string }>
  >`
    SELECT ci.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class ci ON ci.oid = i.indexrelid
    JOIN pg_class ct ON ct.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = ct.relnamespace
    WHERE n.nspname = 'public'
      AND ct.relkind IN ('r', 'p')
      AND (
        i.indpred IS NOT NULL
        OR i.indexprs IS NOT NULL
        OR i.indnatts > i.indnkeyatts
        OR pg_get_indexdef(i.indexrelid) LIKE '%gin_trgm_ops%'
        OR pg_get_indexdef(i.indexrelid) LIKE '%NULLS LAST%'
      )
  `;

  return new Map(rows.map((row) => [row.name, row.definition]));
}

async function checkConstraints(client: Client): Promise<Map<string, string>> {
  const rows = await client.$queryRaw<
    Array<{ name: string; definition: string }>
  >`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace
  `;

  return new Map(rows.map((row) => [row.name, row.definition]));
}

/** What is missing or different, as sentences a failure can print. */
async function drift(client: Client): Promise<string[]> {
  const indexes = await rawIndexes(client);
  const checks = await checkConstraints(client);

  const problems: string[] = [];

  for (const [name, expected] of Object.entries(INDEXES)) {
    const actual = indexes.get(name);

    if (actual === undefined) problems.push(`índice ausente: ${name}`);
    else if (actual !== expected)
      problems.push(`índice alterado: ${name}\n  hoje: ${actual}`);
  }

  for (const [name, expected] of Object.entries(CHECKS)) {
    const actual = checks.get(name);

    if (actual === undefined) problems.push(`CHECK ausente: ${name}`);
    else if (actual !== expected)
      problems.push(`CHECK alterado: ${name}\n  hoje: ${actual}`);
  }

  return problems;
}

describe("objects that only exist in migration SQL", () => {
  it("are all there, exactly as the code expects them", async () => {
    expect(await drift(prisma)).toEqual([]);
  });

  it("include nothing that nobody pinned", async () => {
    // A new partial index or CHECK is a new rule schema.prisma cannot show:
    // it belongs in the lists above, with the line that says what it guards.
    const indexes = await rawIndexes(prisma);
    const checks = await checkConstraints(prisma);

    expect(
      [...indexes.keys()].filter((name) => !(name in INDEXES)).sort(),
    ).toEqual([]);
    expect(
      [...checks.keys()].filter((name) => !(name in CHECKS)).sort(),
    ).toEqual([]);
  });

  it("and the guard notices when one goes missing or changes shape", async () => {
    /**
     * The control: inside a transaction that is rolled back, drop a dedupe
     * index, rebuild a claim index on another column and drop the CHECK. DDL
     * is transactional in Postgres, so nothing survives the test.
     */
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `DROP INDEX "notification_delivery_external_event_channel_idx"`,
        );

        await tx.$executeRawUnsafe(`DROP INDEX "webhook_delivery_claim_idx"`);
        await tx.$executeRawUnsafe(
          `CREATE INDEX "webhook_delivery_claim_idx" ON "webhook_delivery" ("created_at")
           WHERE "status" IN ('PENDING', 'PROCESSING')`,
        );

        await tx.$executeRawUnsafe(
          `ALTER TABLE "notification_delivery" DROP CONSTRAINT "notification_delivery_one_recipient"`,
        );

        const problems = await drift(tx);

        throw Object.assign(new Error("rollback"), { problems });
      })
      .catch((error: Error & { problems?: string[] }) => {
        if (!error.problems) throw error;
        return error.problems;
      });

    expect(seen).toHaveLength(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        "índice ausente: notification_delivery_external_event_channel_idx",
        expect.stringContaining("índice alterado: webhook_delivery_claim_idx"),
        "CHECK ausente: notification_delivery_one_recipient",
      ]),
    );

    // And the rollback left the real ones in place.
    expect(await drift(prisma)).toEqual([]);
  });
});
