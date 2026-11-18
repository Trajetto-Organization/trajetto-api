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

/**
 * `pg_get_indexdef`, schema-qualified as Postgres prints it. The four
 * queues are partitioned by day since the swap of plano-escala F5-09
 * (prisma/post-deploy/10-queue-partition-swap.sql), which every E2E
 * database has run: a partitioned parent's index prints as `ON ONLY`, and
 * each partition's is its clone.
 */
const INDEXES: Record<string, string> = {
  // Queue claims: a range on the key under a partial predicate.
  ai_analysis_request_claim_idx: `CREATE INDEX ai_analysis_request_claim_idx ON public.ai_analysis_request USING btree (created_at) WHERE (status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"]))`,
  ai_analysis_request_fair_claim_idx: `CREATE INDEX ai_analysis_request_fair_claim_idx ON public.ai_analysis_request USING btree ("businessId", created_at) WHERE (status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"]))`,
  // The AI queue company by company, the receipt first (plano-escala
  // F3-12): one fair index per class, and the due range of the fill.
  ai_analysis_request_proof_fair_idx: `CREATE INDEX ai_analysis_request_proof_fair_idx ON public.ai_analysis_request USING btree ("businessId", "availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"])) AND (type = 'DELIVERY_PROOF'::"AIAnalysisType"))`,
  ai_analysis_request_other_fair_idx: `CREATE INDEX ai_analysis_request_other_fair_idx ON public.ai_analysis_request USING btree ("businessId", "availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"])) AND (type <> 'DELIVERY_PROOF'::"AIAnalysisType"))`,
  ai_analysis_request_due_idx: `CREATE INDEX ai_analysis_request_due_idx ON public.ai_analysis_request USING btree ("availableAt") WHERE (status = ANY (ARRAY['PENDING'::"AIAnalysisRequestStatus", 'PROCESSING'::"AIAnalysisRequestStatus"]))`,
  domain_outbox_event_claim_idx: `CREATE INDEX domain_outbox_event_claim_idx ON ONLY public.domain_outbox_event USING btree (created_at) WHERE (status = ANY (ARRAY['PENDING'::"OutboxEventStatus", 'PROCESSING'::"OutboxEventStatus"]))`,
  // The outbox by due time and by company (plano-escala F3-11); the claim
  // index above, by created_at, is the image of before's until wave 20.
  domain_outbox_event_due_idx: `CREATE INDEX domain_outbox_event_due_idx ON ONLY public.domain_outbox_event USING btree ("availableAt") WHERE (status = ANY (ARRAY['PENDING'::"OutboxEventStatus", 'PROCESSING'::"OutboxEventStatus"]))`,
  domain_outbox_event_fair_idx: `CREATE INDEX domain_outbox_event_fair_idx ON ONLY public.domain_outbox_event USING btree ("businessId", "availableAt") WHERE (status = ANY (ARRAY['PENDING'::"OutboxEventStatus", 'PROCESSING'::"OutboxEventStatus"]))`,
  notification_delivery_claim_internal_idx: `CREATE INDEX notification_delivery_claim_internal_idx ON ONLY public.notification_delivery USING btree ("availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['IN_APP'::"NotificationChannel", 'ACTIVITY'::"NotificationChannel", 'PUSH'::"NotificationChannel"])))`,
  notification_delivery_claim_external_idx: `CREATE INDEX notification_delivery_claim_external_idx ON ONLY public.notification_delivery USING btree ("availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['EMAIL'::"NotificationChannel", 'WHATSAPP'::"NotificationChannel"])))`,
  // The fair claim of the lanes (plano-escala F3-09, F3-10): the same
  // claim predicate per lane, by company, then due time.
  notification_delivery_business_internal_idx: `CREATE INDEX notification_delivery_business_internal_idx ON ONLY public.notification_delivery USING btree (business_id, "availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['IN_APP'::"NotificationChannel", 'ACTIVITY'::"NotificationChannel", 'PUSH'::"NotificationChannel"])))`,
  notification_delivery_business_external_idx: `CREATE INDEX notification_delivery_business_external_idx ON ONLY public.notification_delivery USING btree (business_id, "availableAt") WHERE ((status = ANY (ARRAY['PENDING'::"NotificationDeliveryStatus", 'PROCESSING'::"NotificationDeliveryStatus"])) AND (channel = ANY (ARRAY['EMAIL'::"NotificationChannel", 'WHATSAPP'::"NotificationChannel"])))`,
  webhook_delivery_claim_idx: `CREATE INDEX webhook_delivery_claim_idx ON ONLY public.webhook_delivery USING btree ("availableAt") WHERE (status = ANY (ARRAY['PENDING'::"WebhookDeliveryStatus", 'PROCESSING'::"WebhookDeliveryStatus"]))`,
  // The minute's close of the exhausted rows (plano-escala F3-08): only the
  // rows in flight, by when their lease ends, whatever is queued.
  domain_outbox_event_processing_lease_idx: `CREATE INDEX domain_outbox_event_processing_lease_idx ON ONLY public.domain_outbox_event USING btree ("leaseExpiresAt") WHERE (status = 'PROCESSING'::"OutboxEventStatus")`,
  notification_delivery_processing_lease_idx: `CREATE INDEX notification_delivery_processing_lease_idx ON ONLY public.notification_delivery USING btree ("leaseExpiresAt") WHERE (status = 'PROCESSING'::"NotificationDeliveryStatus")`,
  webhook_delivery_processing_lease_idx: `CREATE INDEX webhook_delivery_processing_lease_idx ON ONLY public.webhook_delivery USING btree ("leaseExpiresAt") WHERE (status = 'PROCESSING'::"WebhookDeliveryStatus")`,
  delivery_proof_audit_queue_idx: `CREATE INDEX delivery_proof_audit_queue_idx ON public.delivery_proof_audit USING btree ("businessId", created_at) WHERE (status = 'PENDING'::"ProofAuditStatus")`,
  // The geocoding job's claim (plan of 02/11/2026, E1): the open deliveries
  // still without a point and not settled by the geocoder, newest first.
  delivery_geocode_pending_idx: `CREATE INDEX delivery_geocode_pending_idx ON public.delivery USING btree (created_at) WHERE ((latitude IS NULL) AND (geo_source IS NULL) AND ((geocode_status IS NULL) OR (geocode_status = 'FAILED'::"DeliveryGeocodeStatus")) AND (status = ANY (ARRAY['PENDING'::"DeliveryStatus", 'IN_TRANSIT'::"DeliveryStatus"])))`,
  // The point reuse at one door (14/11/2026): the company's rows with an
  // address key, and only those; the newest point of each source first, so
  // each probe reads one entry.
  delivery_address_key_idx: `CREATE INDEX delivery_address_key_idx ON public.delivery USING btree ("businessId", address_key, geo_source, geo_updated_at DESC NULLS LAST, id DESC) WHERE (address_key IS NOT NULL)`,
  // The pin's follow-up (pre-push review of 14/11/2026): the company's open
  // copies of one source, and only those.
  delivery_geo_copied_from_idx: `CREATE INDEX delivery_geo_copied_from_idx ON public.delivery USING btree ("businessId", geo_copied_from) WHERE ((geo_copied_from IS NOT NULL) AND (status = ANY (ARRAY['PENDING'::"DeliveryStatus", 'IN_TRANSIT'::"DeliveryStatus"])))`,
  // The abandoned-import sweep: only the uploads running right now (IDEMP-10).
  import_in_progress_heartbeat_idx: `CREATE INDEX import_in_progress_heartbeat_idx ON public.import USING btree (updated_at) WHERE (status = 'IN_PROGRESS'::"ImportStatus")`,
  // The tower's authorization queue and the 10-minute escalation sweep:
  // only what still waits (decision 6.3).
  delivery_occurrence_pending_authorization_idx: `CREATE INDEX delivery_occurrence_pending_authorization_idx ON public.delivery_occurrence USING btree ("businessId", created_at) WHERE (authorization_status = 'PENDING'::"OccurrenceAuthorizationStatus")`,

  // No dedupe index on notification_delivery since F5-06: the delivery's
  // id is decided by (event, recipient, channel) (F5-03), and the primary
  // key is what `createMany({ skipDuplicates })` leans on.

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
  notification_delivery_failed_idx: `CREATE INDEX notification_delivery_failed_idx ON ONLY public.notification_delivery USING btree (updated_at, channel) WHERE (status = 'FAILED'::"NotificationDeliveryStatus")`,
  webhook_delivery_failed_idx: `CREATE INDEX webhook_delivery_failed_idx ON ONLY public.webhook_delivery USING btree (updated_at) WHERE (status = 'FAILED'::"WebhookDeliveryStatus")`,
  webhook_delivery_purge_idx: `CREATE INDEX webhook_delivery_purge_idx ON ONLY public.webhook_delivery USING btree (created_at) WHERE (status = ANY (ARRAY['DELIVERED'::"WebhookDeliveryStatus", 'FAILED'::"WebhookDeliveryStatus"]))`,
  // The nightly purge of PUBLISHED outbox events, batched by processedAt
  // (publishedPurgeBatchSql; the plan is pinned in notification-purge-plan).
  domain_outbox_event_published_processed_idx: `CREATE INDEX domain_outbox_event_published_processed_idx ON ONLY public.domain_outbox_event USING btree ("processedAt") WHERE (status = 'PUBLISHED'::"OutboxEventStatus")`,
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
  // The API key behind an INTEGRATION event (L9): the trail's name and the
  // SET NULL from api_key.
  delivery_event_apiKeyId_partial_idx: `CREATE INDEX "delivery_event_apiKeyId_partial_idx" ON public.delivery_event USING btree ("apiKeyId") WHERE ("apiKeyId" IS NOT NULL)`,
  delivery_occurrence_authorizedById_partial_idx: `CREATE INDEX "delivery_occurrence_authorizedById_partial_idx" ON public.delivery_occurrence USING btree ("authorizedById") WHERE ("authorizedById" IS NOT NULL)`,
  delivery_event_reasonId_partial_idx: `CREATE INDEX "delivery_event_reasonId_partial_idx" ON public.delivery_event USING btree ("reasonId") WHERE ("reasonId" IS NOT NULL)`,
  // The integration feed in commit order (plano-escala F2-03, F2-05): one
  // tenant's events by (txid, id), the rows from before the column read as
  // 0. The expression must stay the one the feed and the feed-txid-regressed
  // probe send (COALESCE("txid", 0)), or the planner ignores it.
  delivery_event_feed_idx: `CREATE INDEX delivery_event_feed_idx ON public.delivery_event USING btree ("businessId", COALESCE(txid, (0)::bigint), id)`,
  // The same four on the trail's partitioned shell (plano-escala F2-16),
  // named *_part_* until the copy window renames them; each partition's
  // copy is a clone of these (partitions are left out below).
  delivery_event_part_reasonId_partial_idx: `CREATE INDEX "delivery_event_part_reasonId_partial_idx" ON ONLY public.delivery_event_part USING btree ("reasonId") WHERE ("reasonId" IS NOT NULL)`,
  delivery_event_part_occurrenceId_partial_idx: `CREATE INDEX "delivery_event_part_occurrenceId_partial_idx" ON ONLY public.delivery_event_part USING btree ("occurrenceId") WHERE ("occurrenceId" IS NOT NULL)`,
  delivery_event_part_apiKeyId_partial_idx: `CREATE INDEX "delivery_event_part_apiKeyId_partial_idx" ON ONLY public.delivery_event_part USING btree ("apiKeyId") WHERE ("apiKeyId" IS NOT NULL)`,
  delivery_event_part_feed_idx: `CREATE INDEX delivery_event_part_feed_idx ON ONLY public.delivery_event_part USING btree ("businessId", COALESCE(txid, (0)::bigint), id)`,
  // A delivery's and a route's tickets, and the SET NULL paths of the
  // ticket's context and people (decision 14.5).
  support_ticket_deliveryId_partial_idx: `CREATE INDEX "support_ticket_deliveryId_partial_idx" ON public.support_ticket USING btree ("deliveryId") WHERE ("deliveryId" IS NOT NULL)`,
  support_ticket_routeId_partial_idx: `CREATE INDEX "support_ticket_routeId_partial_idx" ON public.support_ticket USING btree ("routeId") WHERE ("routeId" IS NOT NULL)`,
  support_ticket_openedById_partial_idx: `CREATE INDEX "support_ticket_openedById_partial_idx" ON public.support_ticket USING btree ("openedById") WHERE ("openedById" IS NOT NULL)`,
  support_ticket_assigneeId_partial_idx: `CREATE INDEX "support_ticket_assigneeId_partial_idx" ON public.support_ticket USING btree ("assigneeId") WHERE ("assigneeId" IS NOT NULL)`,
  support_ticket_closedById_partial_idx: `CREATE INDEX "support_ticket_closedById_partial_idx" ON public.support_ticket USING btree ("closedById") WHERE ("closedById" IS NOT NULL)`,
  support_ticket_event_actorId_partial_idx: `CREATE INDEX "support_ticket_event_actorId_partial_idx" ON public.support_ticket_event USING btree ("actorId") WHERE ("actorId" IS NOT NULL)`,
  notification_delivery_providerMessageId_idx: `CREATE INDEX "notification_delivery_providerMessageId_idx" ON ONLY public.notification_delivery USING btree ("providerMessageId") WHERE ("providerMessageId" IS NOT NULL)`,
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
  // Plan of 02/11/2026 (M1, decision D12): the geofence radius is bounded in
  // the database too — a few metres would block honest drivers on GPS noise,
  // tens of kilometres would be no control at all.
  business_settings_geofence_radius_chk: `CHECK (((arrival_geofence_radius_m >= 50) AND (arrival_geofence_radius_m <= 5000)))`,
  // Plan of 02/11/2026 (B3): the body may go NULL only on WhatsApp, which
  // goes out as a fixed template; the e-mail always has the company's text.
  delivery_message_template_email_body_chk: `CHECK (((channel <> 'EMAIL'::"NotificationChannel") OR (body IS NOT NULL)))`,
  // Wave 2 (06/11/2026): a phone is trusted for CPF sign-in only by a QR it
  // consumed or by the rollout backfill; nothing else may mint that trust.
  driver_trusted_device_source_chk: `CHECK ((source = ANY (ARRAY['qr'::text, 'backfill'::text])))`,
  // Scale plan F1-12: pgss_state holds the state of the last query-stats
  // snapshot, one row only; the hourly job upserts it and never logs there.
  pgss_state_single_row: `CHECK ((id = 1))`,
  // Plano-escala F5-08: a release step's state is one of the five words
  // infra/scripts/release-step-runner.ts writes, and nothing else.
  // Plano-escala U-14: the cluster has one epoch at a time; the release
  // step (infra/sql/50-cluster-epoch.sql) keeps that one row.
  cluster_epoch_single_row: `CHECK ((id = 1))`,
  release_step_state_status_check: `CHECK ((status = ANY (ARRAY['applied'::text, 'skipped'::text, 'pending'::text, 'failed'::text, 'retired'::text])))`,
};

/**
 * The planner's settings, also only in migration SQL (plano-escala F2-22):
 * schema.prisma has no word for them and `migrate diff` ignores them, yet
 * the plans of the hot tables lean on them. A target that drops back to the
 * default puts the long tail's estimates 20 to 200 times off again
 * (tests/E2E/query-plans-scale.test.ts); a scale factor that goes back to
 * 20% lets a 5M-row table pile up a million dead rows.
 */
const STATISTICS_TARGETS: Record<string, number> = {
  "activity.businessId": 1000,
  "activity_part.businessId": 1000,
  "delivery.businessId": 1000,
  "delivery_event.businessId": 1000,
  "delivery_event_part.businessId": 1000,
  "delivery_occurrence.businessId": 1000,
  "route.businessId": 1000,
  "webhook_delivery.businessId": 1000,
};

/**
 * `pg_get_statisticsobjdef` (columns in table order): dependencies only,
 * why in prisma/concurrent/20261117180000_tenant_statistics.sql.
 */
const EXTENDED_STATISTICS: Record<string, string> = {
  delivery_business_driver_stats: `CREATE STATISTICS public.delivery_business_driver_stats (dependencies) ON "businessId", "driverId" FROM delivery`,
  delivery_business_status_stats: `CREATE STATISTICS public.delivery_business_status_stats (dependencies) ON status, "businessId" FROM delivery`,
  route_business_driver_stats: `CREATE STATISTICS public.route_business_driver_stats (dependencies) ON "businessId", "driverId" FROM route`,
  route_business_status_stats: `CREATE STATISTICS public.route_business_status_stats (dependencies) ON status, "businessId" FROM route`,
};

const HOT_AUTOVACUUM = [
  "autovacuum_vacuum_scale_factor=0.02",
  "autovacuum_analyze_scale_factor=0.01",
];

// The queues: claims rewrite each row in place (fillfactor 70 leaves room
// for the HOT update) and the dead rows are vacuumed early and cheaply
// (20260908120000_harden_queue_tables, 20260916170000_integrations).
const QUEUE_AUTOVACUUM = [
  "autovacuum_vacuum_scale_factor=0.01",
  "autovacuum_analyze_scale_factor=0.01",
  "autovacuum_vacuum_cost_delay=2",
  "fillfactor=70",
];

/** `pg_class.reloptions` of every table that has any. */
const STORAGE_PARAMETERS: Record<string, string[]> = {
  // F2-22.
  delivery: HOT_AUTOVACUUM,
  delivery_occurrence: HOT_AUTOVACUUM,
  route: HOT_AUTOVACUUM,
  route_stop: HOT_AUTOVACUUM,
  ai_analysis_request: QUEUE_AUTOVACUUM,
  ai_analysis_unit: QUEUE_AUTOVACUUM,
  // The four queues are partitioned parents since F5-09, which Postgres
  // refuses these on: each partition carries them instead (the swap copies
  // the plain table's, the partition job QUEUE_RELOPTIONS of
  // src/shared/database/partitions.ts), pinned in
  // tests/E2E/queue-partition-swap.test.ts.
  // One upserted row per key and day (20260916230000_api_usage).
  api_key_usage_daily: [
    "autovacuum_vacuum_scale_factor=0.02",
    "autovacuum_analyze_scale_factor=0.02",
  ],
  // One row per driver, rewritten on every flush: HOT room since F2-13.
  driver_last_position: [
    "autovacuum_vacuum_scale_factor=0.05",
    "autovacuum_analyze_scale_factor=0.05",
    "fillfactor=80",
  ],
};

type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

/** Every column with a statistics target of its own, as `table.column`. */
async function statisticsTargets(client: Client): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<Array<{ name: string; target: number }>>`
    SELECT c.relname || '.' || a.attname AS name, a.attstattarget::int AS target
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
      AND coalesce(a.attstattarget, -1) <> -1
  `;

  return new Map(rows.map((row) => [row.name, row.target]));
}

async function extendedStatistics(
  client: Client,
): Promise<Map<string, string>> {
  const rows = await client.$queryRaw<
    Array<{ name: string; definition: string }>
  >`
    SELECT stxname AS name, pg_get_statisticsobjdef(oid) AS definition
    FROM pg_statistic_ext
    WHERE stxnamespace = 'public'::regnamespace
  `;

  return new Map(rows.map((row) => [row.name, row.definition]));
}

/** Partitions made by the job are left out: they copy nothing of these. */
async function storageParameters(
  client: Client,
): Promise<Map<string, string[]>> {
  const rows = await client.$queryRaw<
    Array<{ name: string; options: string[] }>
  >`
    SELECT c.relname AS name, c.reloptions AS options
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND c.reloptions IS NOT NULL
      AND NOT c.relispartition
  `;

  return new Map(rows.map((row) => [row.name, row.options]));
}

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
      -- A partition's index is the clone of its parent's, pinned there;
      -- the partitions' names carry their dates (plano-escala F2-16).
      AND NOT ct.relispartition
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

  const targets = await statisticsTargets(client);

  for (const [name, expected] of Object.entries(STATISTICS_TARGETS)) {
    const actual = targets.get(name);

    if (actual !== expected) {
      problems.push(
        `alvo de estatística alterado: ${name} (hoje ${actual ?? "padrão"})`,
      );
    }
  }

  const statistics = await extendedStatistics(client);

  for (const [name, expected] of Object.entries(EXTENDED_STATISTICS)) {
    const actual = statistics.get(name);

    if (actual === undefined) problems.push(`estatística ausente: ${name}`);
    else if (actual !== expected)
      problems.push(`estatística alterada: ${name}\n  hoje: ${actual}`);
  }

  const parameters = await storageParameters(client);

  for (const [name, expected] of Object.entries(STORAGE_PARAMETERS)) {
    const actual = parameters.get(name) ?? [];

    if ([...actual].sort().join(",") !== [...expected].sort().join(",")) {
      problems.push(
        `parâmetros de ${name} alterados: hoje ${actual.join(", ") || "nenhum"}`,
      );
    }
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

    // Nor a planner setting nobody wrote down (F2-22).
    expect(
      [...(await statisticsTargets(prisma)).keys()]
        .filter((name) => !(name in STATISTICS_TARGETS))
        .sort(),
    ).toEqual([]);
    expect(
      [...(await extendedStatistics(prisma)).keys()]
        .filter((name) => !(name in EXTENDED_STATISTICS))
        .sort(),
    ).toEqual([]);
    expect(
      [...(await storageParameters(prisma)).keys()]
        .filter((name) => !(name in STORAGE_PARAMETERS))
        .sort(),
    ).toEqual([]);
  });

  it("and the guard notices when one goes missing or changes shape", async () => {
    /**
     * The control: inside a transaction that is rolled back, drop a partial
     * index, rebuild a claim index on another column and drop the CHECK. DDL
     * is transactional in Postgres, so nothing survives the test.
     */
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `DROP INDEX "notification_delivery_failed_idx"`,
        );

        await tx.$executeRawUnsafe(`DROP INDEX "webhook_delivery_claim_idx"`);
        await tx.$executeRawUnsafe(
          `CREATE INDEX "webhook_delivery_claim_idx" ON "webhook_delivery" ("created_at")
           WHERE "status" IN ('PENDING', 'PROCESSING')`,
        );

        await tx.$executeRawUnsafe(
          `ALTER TABLE "notification_delivery" DROP CONSTRAINT "notification_delivery_one_recipient"`,
        );

        // And a planner setting (F2-22) back to the default.
        await tx.$executeRawUnsafe(
          `ALTER TABLE "delivery" ALTER COLUMN "businessId" SET STATISTICS -1`,
        );
        await tx.$executeRawUnsafe(
          `DROP STATISTICS "route_business_driver_stats"`,
        );

        const problems = await drift(tx);

        throw Object.assign(new Error("rollback"), { problems });
      })
      .catch((error: Error & { problems?: string[] }) => {
        if (!error.problems) throw error;
        return error.problems;
      });

    expect(seen).toHaveLength(5);
    expect(seen).toEqual(
      expect.arrayContaining([
        "índice ausente: notification_delivery_failed_idx",
        expect.stringContaining("índice alterado: webhook_delivery_claim_idx"),
        "CHECK ausente: notification_delivery_one_recipient",
        "alvo de estatística alterado: delivery.businessId (hoje padrão)",
        "estatística ausente: route_business_driver_stats",
      ]),
    );

    // And the rollback left the real ones in place.
    expect(await drift(prisma)).toEqual([]);
  });
});
