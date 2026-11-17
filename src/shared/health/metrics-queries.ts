import { NotificationChannel, Prisma } from "@prisma/client";

import {
  DELIVERY_LANES,
  type DeliveryLane,
} from "@/shared/notifications/pipeline-rules";
import {
  webhookDisabledEndpointsSql,
  webhookQueueSql,
} from "@/shared/integration/webhook-metrics";

/**
 * The SQL behind /health/metrics and /health/dead-letter (OBS-09, PG-18).
 *
 * Every statement here is written against an index that exists for it, and
 * tests/E2E/health-metrics-plans.test.ts EXPLAINs each one with sequential
 * scans disabled and a GENERIC plan forced. That second part is why these are
 * raw SQL and not Prisma's groupBy/count: Prisma binds every value, the
 * status included, and a partial index (`WHERE status = 'FAILED'`) can only
 * be used when the planner can PROVE the predicate — which it cannot from
 * `status = $1` once Postgres switches a prepared statement to its generic
 * plan. So the statuses and the lane channel lists are SQL literals, spelled
 * here from constants of this code base, never from input.
 *
 * The indexes, for whoever changes a query:
 *  - notification_delivery_failed_idx ("updated_at", "channel")
 *    WHERE status = 'FAILED' — dead letter, its count, failures per channel;
 *  - notification_delivery_pkey — "created in the last 24 h", as a range of
 *    uuid v7 ids (deliveriesInWindowSql says why not the created_at BRIN);
 *  - notification_delivery_claim_{internal,external}_idx — partial on
 *    status IN ('PENDING','PROCESSING') AND channel IN (<lane>): the backlog;
 *  - webhook_delivery_failed_idx ("updated_at") WHERE status = 'FAILED';
 *  - ai_analysis_request (status, availableAt);
 *  - notification_provider_receipt (provider, status, created_at) — Meta's
 *    callbacks of the last 24 h (failed, and more than one wamid).
 */

/** Literal list of a lane's channels, for a partial-index-provable IN (...). */
function laneChannels(lane: DeliveryLane): Prisma.Sql {
  return Prisma.raw(
    DELIVERY_LANES[lane].map((channel) => `'${channel}'`).join(", "),
  );
}

/** Tables the dead-tuple watch covers: written, claimed and updated per event. */
const QUEUE_TABLES = [
  "domain_outbox_event",
  "notification_delivery",
  "ai_analysis_request",
  "webhook_delivery",
] as const;

/**
 * n_live_tup / n_dead_tup are the statistics collector's estimates, not a
 * count — cheap to read and precise enough for a threshold.
 */
function queueTableStatsSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      relname::text AS table_name,
      n_live_tup,
      n_dead_tup,
      last_autovacuum
    FROM pg_stat_user_tables
    WHERE relname = ANY(${[...QUEUE_TABLES]}::text[])
  `;
}

/**
 * The smallest uuid v7 a delivery minted at or after `since` can carry.
 *
 * A uuid v7 starts with its millisecond timestamp in hex, so its text sorts
 * in time order. Relies on NotificationDelivery.id being `@default(uuid(7))`,
 * minted by the client at insert — pinned by
 * tests/unitaires/health/delivery-id-floor.test.ts. Same technique as
 * eventIdFloor in integration-repository.ts.
 */
function deliveryIdFloor(since: Date): string {
  const hex = Math.max(0, since.getTime()).toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/**
 * Deliveries created since `since`, by channel and status: a range of the
 * primary key, uuid v7 ids from the window's first millisecond on.
 *
 * Not `created_at >= since` over the BRIN on created_at. On a fresh table the
 * BRIN is narrow and its plan looks right; this table is not fresh. Every row
 * is claimed and settled by non-HOT updates and purged after 30 days, the new
 * versions go wherever the free space map finds room — pages written weeks
 * ago — and a BRIN range only ever widens. One recent row in a page makes its
 * whole 128-page range match, and two simulated weeks of churn and purges had
 * the BRIN matching every page for a one-day window: a full read of the
 * table — at the target volume, long enough for the statement_timeout to
 * fail the endpoint.
 *
 * The pkey is a btree: a range of it touches the window's rows wherever they
 * sit. No created_at predicate on purpose — with one, the planner may still
 * pick the BRIN. The id's millisecond is the client's clock at insert, within
 * milliseconds of created_at; for a 24-hour counter that is the same window.
 * tests/E2E/health-metrics-window-scan.test.ts builds the churned table.
 */
function deliveriesInWindowSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT "channel"::text AS channel, "status"::text AS status, count(*)::int AS n
    FROM "notification_delivery"
    WHERE "id" >= ${deliveryIdFloor(since)}
    GROUP BY 1, 2
  `;
}

/** Every FAILED delivery still kept, by channel (index-only on the failed index). */
function failedByChannelSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT "channel"::text AS channel, count(*)::int AS n
    FROM "notification_delivery"
    WHERE "status" = 'FAILED'
    GROUP BY 1
  `;
}

/**
 * The CURRENT backlog of one lane, per channel — not "created in the last
 * 24 hours": a delivery stuck for two days used to drop out of that window
 * and out of every number on the screen.
 *
 * `oldest_pending_seconds` is measured from created_at, not availableAt. A
 * row in backoff has a future availableAt, so the availableAt-based lag reads
 * nothing exactly while a provider is down and everything is retrying — the
 * outbox's `eligible` lag has the same blindness, and the operator was shown
 * green through a WhatsApp outage (OBS-04). `oldest_eligible_seconds` is kept
 * next to it because "due and not taken" is the other question: are the
 * workers keeping up?
 *
 * PROCESSING rows carry their lease end in availableAt (the claim writes it
 * there), so only PENDING rows count as eligible; a PROCESSING row whose
 * lease ran out is counted apart — that is a worker that died mid-send.
 */
function deliveryBacklogSql(lane: DeliveryLane): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "channel"::text AS channel,
      count(*) FILTER (WHERE "status" = 'PENDING')::int AS pending_total,
      count(*) FILTER (WHERE "status" = 'PROCESSING')::int AS processing_total,
      count(*) FILTER (
        WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" < now()
      )::int AS processing_lease_expired,
      EXTRACT(EPOCH FROM (now() - MIN("created_at")))::float AS oldest_pending_seconds,
      EXTRACT(EPOCH FROM (
        now() - MIN("availableAt") FILTER (
          WHERE "status" = 'PENDING' AND "availableAt" <= now()
        )
      ))::float AS oldest_eligible_seconds
    FROM "notification_delivery"
    WHERE "status" IN ('PENDING', 'PROCESSING')
      AND "channel" IN (${laneChannels(lane)})
    GROUP BY 1
  `;
}

function channelFilter(channel?: NotificationChannel): Prisma.Sql {
  return channel
    ? Prisma.sql`AND d."channel" = ${channel}::"NotificationChannel"`
    : Prisma.empty;
}

/** Size of the dead letter, optionally for one channel. */
function deadLetterCountSql(channel?: NotificationChannel): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS total
    FROM "notification_delivery" d
    WHERE d."status" = 'FAILED' ${channelFilter(channel)}
  `;
}

/**
 * One page of the dead letter, newest failure first: a backward scan of the
 * failed index that stops at the page, then the event of each row by its
 * primary key. updated_at is when it gave up — the date an operator looks
 * for, not when it was enqueued.
 */
function deadLetterPageSql(
  channel: NotificationChannel | undefined,
  limit: number,
  offset: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      d."id",
      d."channel"::text AS channel,
      d."userId",
      d."externalRecipientId",
      d."attempts",
      d."lastError",
      d."created_at",
      d."updated_at",
      e."topic",
      e."businessId",
      d."outboxEventId",
      e."correlationId"
    FROM "notification_delivery" d
    JOIN "domain_outbox_event" e ON e."id" = d."outboxEventId"
    WHERE d."status" = 'FAILED' ${channelFilter(channel)}
    ORDER BY d."updated_at" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

interface DeadLetterRow {
  id: string;
  channel: NotificationChannel;
  userId: string | null;
  externalRecipientId: string | null;
  attempts: number;
  lastError: string | null;
  created_at: Date;
  updated_at: Date;
  topic: string;
  businessId: string | null;
  outboxEventId: string;

  /** The x-request-id of the request that published the event (OBS-06). */
  correlationId: string | null;
}

/** Webhook rows that gave up since `since` (partial webhook_delivery_failed_idx). */
function webhookFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "webhook_delivery"
    WHERE "status" = 'FAILED' AND "updated_at" >= ${since}
  `;
}

/**
 * WhatsApp messages Meta accepted and then reported `failed` since `since`
 * (OUTBOX-07): number without WhatsApp, template paused after the send,
 * ecosystem refusals. Their delivery stays DELIVERED — the provider took it —
 * so no delivery counter sees them; only the receipts ledger does. One row
 * per failed wamid (the ledger is unique on provider, message id, status).
 * `created_at` is when the callback reached us, the column the index has.
 */
function whatsappFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "notification_provider_receipt"
    WHERE "provider" = 'meta'
      AND "status" = 'failed'
      AND "created_at" >= ${since}
  `;
}

/**
 * Deliveries whose message reached Meta more than once — two or more wamids
 * reported for one delivery — among the callbacks received since `since`.
 * The duplicate at-least-once allows (ADR 0003: WhatsApp has no idempotency
 * key); the same rule as the "reached Meta more than once" log line, counted.
 * Every status Meta reports is listed so a wamid whose `sent` callback was
 * lost still counts, and the list is a literal so the index range is
 * provable under a generic plan. A duplicate whose two sends straddle the
 * window's start is not counted: a 24-hour counter, not an audit.
 */
function whatsappMultiSendSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM (
      SELECT "deliveryId"
      FROM "notification_provider_receipt"
      WHERE "provider" = 'meta'
        AND "status" IN ('sent', 'delivered', 'read', 'failed')
        AND "created_at" >= ${since}
        AND "deliveryId" IS NOT NULL
      GROUP BY "deliveryId"
      HAVING count(DISTINCT "providerMessageId") > 1
    ) repeated
  `;
}

/** AI requests that gave up since `since` ((status, availableAt) index). */
function aiFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "ai_analysis_request"
    WHERE "status" = 'FAILED' AND "updated_at" >= ${since}
  `;
}

/** Outbox events waiting: how many, and the two lags (see the route). */
function outboxPendingSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*)::int AS pending,
      EXTRACT(EPOCH FROM (
        now() - MIN(CASE WHEN "availableAt" <= now() THEN "availableAt" END)
      ))::float AS eligible_seconds,
      EXTRACT(EPOCH FROM (now() - MIN("created_at")))::float AS any_seconds
    FROM "domain_outbox_event"
    WHERE "status" = 'PENDING'
  `;
}

/**
 * Outbox events that gave up. Its own statement, not a FILTER of the one
 * above: that one reads created_at from the heap, and a FILTER would drag
 * every FAILED row ever kept through the same heap read; alone, this is an
 * index-only count on (status, availableAt).
 */
function outboxFailedSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "domain_outbox_event"
    WHERE "status" = 'FAILED'
  `;
}

/** The AI queue: waiting and running, index-only on (status, availableAt). */
function aiQueueSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "status" = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE "status" = 'PROCESSING')::int AS running
    FROM "ai_analysis_request"
    WHERE "status" IN ('PENDING', 'PROCESSING')
  `;
}

/** A row-returning statement as one JSON array column ([] when empty). */
function asJsonArray(rows: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT coalesce(json_agg(r), '[]'::json) FROM (${rows}) r)`;
}

/**
 * Every queue number of /health/metrics in ONE statement.
 *
 * They were twenty-odd statements in a row — each one a round trip and a
 * checkout of the replica's pool — on the screen that is opened when the
 * pool is the thing in trouble. Each statement above becomes a subquery
 * here, unchanged: Postgres plans every scalar subquery (and every
 * json_agg'ed one) on its own, so each still reads the index its plan test
 * pins (tests/E2E/health-metrics-plans.test.ts EXPLAINs both the parts and
 * this whole). One statement, one connection, one round trip.
 *
 * Row-returning parts (per-channel counts, the backlog of both lanes, the
 * dead-tuple statistics) come back as JSON arrays; timestamps in them are
 * timestamptz, so they carry their offset.
 */
function operationalSnapshotSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database())::int AS active_connections,
      current_setting('max_connections') AS max_connections,
      outbox.pending AS outbox_pending,
      outbox.eligible_seconds AS outbox_eligible_seconds,
      outbox.any_seconds AS outbox_any_seconds,
      (${outboxFailedSql()}) AS outbox_failed,
      ai.pending AS ai_pending,
      ai.running AS ai_running,
      (${aiFailedSinceSql(since)}) AS ai_failed_24h,
      (${webhookFailedSinceSql(since)}) AS webhooks_failed_24h,
      (${whatsappFailedSinceSql(since)}) AS whatsapp_failed_24h,
      (${whatsappMultiSendSinceSql(since)}) AS whatsapp_multi_send_24h,
      webhook_queue.pending_due AS webhook_pending_due,
      webhook_queue.held AS webhook_held,
      webhook_queue.oldest_due_seconds AS webhook_oldest_due_seconds,
      (${webhookDisabledEndpointsSql()}) AS webhook_disabled_endpoints,
      ${asJsonArray(deliveriesInWindowSql(since))} AS window_rows,
      ${asJsonArray(failedByChannelSql())} AS failed_rows,
      ${asJsonArray(
        Prisma.sql`(${deliveryBacklogSql("internal")}) UNION ALL (${deliveryBacklogSql("external")})`,
      )} AS backlog_rows,
      ${asJsonArray(queueTableStatsSql())} AS queue_table_rows
    FROM (${outboxPendingSql()}) outbox
    CROSS JOIN (${aiQueueSql()}) ai
    CROSS JOIN (${webhookQueueSql()}) webhook_queue
  `;
}

/**
 * The tables whose growth and churn the scale plan watches (plano-escala,
 * "Tabelas quentes por tempo" and the mutable state beside them): the GPS
 * trail, the delivery history, the audit trail, the bell, the sessions, the
 * queues, the deliveries themselves and the series. A partitioned one is
 * reported once, by its root, with its partitions summed: the trail is ~90
 * daily partitions, and a row per partition would bury the number.
 */
const HOT_TABLES = [
  "driver_position",
  "driver_position_v2",
  "delivery_event",
  "activity",
  "notification",
  "refresh_token",
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
  "webhook_delivery",
  "ai_analysis_request",
  "delivery",
  "route",
  "route_stop",
  "delivery_occurrence",
  "ops_sample",
] as const;

/**
 * The parameters the capacity reading compares against (shared_buffers
 * derived from the memory limit, the WAL ceiling, the archiver, the freeze
 * age the xid alert is read against). Only settings that hold no secret:
 * never archive_command or a connection string, which can carry one.
 */
const DATABASE_PARAMETERS = [
  "server_version_num",
  "max_connections",
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "maintenance_work_mem",
  "max_wal_size",
  "wal_level",
  "archive_mode",
  "archive_timeout",
  "autovacuum_freeze_max_age",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "shared_preload_libraries",
  "compute_query_id",
] as const;

/**
 * The first of the three database reads of /health/metrics (plano-escala
 * F1-06): ONE statement, every part a subquery joined on `true`, so a view
 * with no row (a stats reset, a database without its pg_stat_database row)
 * leaves its columns null instead of emptying the answer.
 *
 *  - xid: the oldest unfrozen xid of the CLUSTER (wraparound is per cluster:
 *    template0 and any other database count) and of this database;
 *  - hit ratio: pg_stat_database since its last reset; the counters go out
 *    too, so a series can take the difference between two minutes;
 *  - the oldest WRITE transaction of the cluster (a backend that holds an
 *    xid, so it has written or is about to) and the oldest snapshot (any
 *    backend_xmin): both hold back vacuum, and the feed of the plan waits on
 *    the second. This statement's own backend is left out. Without
 *    superuser or pg_read_all_stats, other roles' sessions read null here;
 *    `stats_cluster_wide` says which;
 *  - pg_stat_archiver, readable by anyone;
 *  - the hot tables by partition root, from the statistics collector's
 *    estimates (pg_stat_user_tables), never a count;
 *  - the safe parameters and what pg_stat_statements needs: whether the
 *    extension exists and whether the library is preloaded. A preloaded
 *    library is proof it loaded, because the server does not start when it
 *    cannot; the view itself is not read here. The parameters come through
 *    pg_settings, which lists only what this user may read: a
 *    current_setting() of shared_preload_libraries without
 *    pg_read_all_settings fails the WHOLE statement (42501), which is what
 *    the runtime's own login would get after the cut of the database roles
 *    (F3-18). An unreadable one is absent, read as null;
 *  - whether this user may list pg_wal (the second read).
 *
 * clock_timestamp(), not now(): a transaction that began after this one did
 * would otherwise read a negative age.
 */
function databaseCoreSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (SELECT max(age(datfrozenxid)) FROM pg_database)::float8 AS xid_age,
      (SELECT age(datfrozenxid) FROM pg_database
        WHERE datname = current_database())::float8 AS xid_age_database,
      (SELECT max(mxid_age(datminmxid)) FROM pg_database)::float8 AS mxid_age,
      db.blks_hit::float8 AS blocks_hit,
      db.blks_read::float8 AS blocks_read,
      activity.oldest_write_xact_seconds,
      activity.oldest_snapshot_seconds,
      activity.oldest_snapshot_xmin_age,
      archiver.archived_count::float8 AS archived_count,
      archiver.failed_count::float8 AS archive_failed_count,
      archiver.last_archived_time AS last_archived_at,
      EXTRACT(EPOCH FROM (clock_timestamp() - archiver.last_archived_time))::float8
        AS last_archived_age_seconds,
      archiver.last_failed_time AS last_archive_failed_at,
      (SELECT coalesce(json_agg(t ORDER BY t.table_name), '[]'::json) FROM (
        SELECT
          coalesce(root.relname, c.relname)::text AS table_name,
          count(*)::int AS partitions,
          coalesce(sum(s.n_live_tup), 0)::float8 AS n_live_tup,
          coalesce(sum(s.n_dead_tup), 0)::float8 AS n_dead_tup,
          max(s.last_autovacuum) AS last_autovacuum
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid AND c.relkind = 'r'
        LEFT JOIN pg_class root ON root.oid = pg_partition_root(c.oid)
        WHERE s.schemaname = current_schema()
          AND coalesce(root.relname, c.relname) = ANY(${[...HOT_TABLES]}::text[])
        GROUP BY 1
      ) t) AS hot_tables,
      (SELECT json_object_agg(s.name, current_setting(s.name))
         FROM pg_settings s
        WHERE s.name = ANY(${[...DATABASE_PARAMETERS]}::text[])) AS parameters,
      EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      ) AS pgss_installed,
      (
        coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
        OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
      ) AS stats_cluster_wide,
      has_function_privilege('pg_ls_waldir()', 'EXECUTE') AS wal_readable
    FROM (SELECT 1) one
    LEFT JOIN (
      SELECT blks_hit, blks_read FROM pg_stat_database
      WHERE datname = current_database()
    ) db ON true
    LEFT JOIN (
      SELECT
        EXTRACT(EPOCH FROM max(clock_timestamp() - xact_start)
          FILTER (WHERE backend_xid IS NOT NULL))::float8
          AS oldest_write_xact_seconds,
        EXTRACT(EPOCH FROM max(clock_timestamp() - xact_start)
          FILTER (WHERE backend_xmin IS NOT NULL))::float8
          AS oldest_snapshot_seconds,
        max(age(backend_xmin))::float8 AS oldest_snapshot_xmin_age
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
    ) activity ON true
    LEFT JOIN pg_stat_archiver archiver ON true
  `;
}

/**
 * The second read: what pg_wal holds, files and bytes. Its own statement,
 * run only when the first said this user may (superuser or pg_monitor):
 * otherwise pg_ls_waldir() refuses, and a refusal would fail a statement
 * that carries nothing else. A full pg_wal is how an archiver that stopped
 * becomes a database that stops.
 */
function databaseWalSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS files, coalesce(sum(size), 0)::float8 AS bytes
    FROM pg_ls_waldir()
  `;
}

/**
 * The third read, cached for five minutes by its caller: the database's size
 * and each hot table's (with its indexes and TOAST, partitions summed under
 * the root). pg_database_size walks the data directory, so it is not read on
 * every 10-second snapshot; sizes move by the day, not by the minute.
 */
function databaseSizesSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      pg_database_size(current_database())::float8 AS database_bytes,
      (SELECT coalesce(json_agg(t ORDER BY t.table_name), '[]'::json) FROM (
        SELECT
          coalesce(root.relname, c.relname)::text AS table_name,
          sum(pg_total_relation_size(c.oid))::float8 AS total_bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_class root ON root.oid = pg_partition_root(c.oid)
        WHERE c.relkind = 'r'
          AND n.nspname = current_schema()
          AND coalesce(root.relname, c.relname) = ANY(${[...HOT_TABLES]}::text[])
        GROUP BY 1
      ) t) AS tables
  `;
}

/**
 * The database block of the newest cluster row (ops_sample, role
 * 'cluster') written after `since` (plano-escala F3-18): what the cron
 * process read on the maintenance pool, with pg_read_all_stats and
 * pg_monitor, that the runtime's own login may not read after the cut of
 * the database roles. A backward walk of the ts index, a few rows per
 * minute.
 */
function latestClusterDatabaseSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT ts, metrics->'database' AS database
    FROM ops_sample
    WHERE ts > ${since} AND role = 'cluster'
    ORDER BY ts DESC
    LIMIT 1
  `;
}

export {
  DATABASE_PARAMETERS,
  HOT_TABLES,
  QUEUE_TABLES,
  aiFailedSinceSql,
  aiQueueSql,
  databaseCoreSql,
  databaseSizesSql,
  databaseWalSql,
  operationalSnapshotSql,
  outboxFailedSql,
  outboxPendingSql,
  deadLetterCountSql,
  deadLetterPageSql,
  deliveriesInWindowSql,
  deliveryBacklogSql,
  deliveryIdFloor,
  failedByChannelSql,
  latestClusterDatabaseSql,
  queueTableStatsSql,
  webhookFailedSinceSql,
  whatsappFailedSinceSql,
  whatsappMultiSendSinceSql,
};
export type { DeadLetterRow };
