#!/usr/bin/env node
/**
 * A day of the notification family drained and then dropped under load
 * (plano-escala LOAD-11; the 5M gate's "DROP de um dia de fila em < 1 min
 * sob carga").
 *
 * At the 5M step a day of the queues is half a million events and as many
 * deliveries. They leave by day (F5-11): the partition-maintenance job asks
 * the notification-family gate (nothing in flight, the failures in the dead
 * letters, the keys gone) and then DETACHes CONCURRENTLY and DROPs the
 * day's partition of each table. This scene proves that night's work on a
 * full day while the API serves the gate's load:
 *
 *  1. it writes one day of the family into an existing day partition, by
 *     SQL, as the seed writes (ids minted as uuid v7 at instants of that
 *     day): QUEUE_DROP_EVENTS (500 000) settled `activity.recorded` events
 *     with their keys and ACTIVITY deliveries, QUEUE_DROP_FAILED (1 000) of
 *     them FAILED (the dead letters' copy), QUEUE_DROP_RECEIPTS (10 000)
 *     receipts, and QUEUE_DROP_PENDING (5 000) events still PENDING;
 *  2. it waits until the harness' pipeline drained the pending ones (the
 *     gate keeps a day with anything in flight): the drain of the day;
 *  3. it runs the partition-maintenance job of this tree on the three
 *     tables of the family, with the retention set so that this day, and
 *     no later one, is past it, and the gate let through for this day
 *     only (the legacy partition and every other day are kept, as a night
 *     that found them in flight would keep them), and times it;
 *  4. it checks the three partitions are gone and the failures in the
 *     dead letters, and runs the job again with the real retention: every
 *     day a row may land in now must be there (`missingNow` empty).
 *
 * The day is QUEUE_DROP_DAY (YYYY-MM-DD) or, by default, the oldest day
 * partition before yesterday, else the newest one from the day after
 * tomorrow: today's, yesterday's and tomorrow's are where the API writes.
 * The load runs beside it (load.js or positions-5m.js, with their
 * summary-export), and lib/verdicts.mjs `queue-drop` judges the two
 * together. The summary goes to QUEUE_DROP_OUT
 * (tests/load/results/queue-drop.json); the DROP's window is printed as
 * `QUEUE_DROP_WINDOW {"from":…,"to":…}` for lib/ops-window.mjs.
 *
 * Only into the disposable database (lib/disposable-database.ts: 54321 or
 * LOAD_PG_PORT, on localhost), with the harness' Redis; every other
 * database URL of the app is pinned to that one before the app's modules
 * load, so the repository's .env cannot point the DDL elsewhere:
 *
 *   NODE_ENV=test REDIS_URL=redis://localhost:56379 \
 *     DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
 *     npx tsx tests/load/queue-drop-under-load.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { assertDisposableDatabase } from "./lib/disposable-database.ts";

const env = process.env;

function intOf(value, fallback, min = 0) {
  const parsed = Math.floor(Number(value));

  return Number.isFinite(parsed) && value !== "" && value !== undefined
    ? Math.max(min, parsed)
    : fallback;
}

const EVENTS = intOf(env.QUEUE_DROP_EVENTS, 500_000, 1);
const FAILED = Math.min(intOf(env.QUEUE_DROP_FAILED, 1_000), EVENTS);
const RECEIPTS = intOf(env.QUEUE_DROP_RECEIPTS, 10_000);
const PENDING = intOf(env.QUEUE_DROP_PENDING, 5_000);
const TENANTS = intOf(env.QUEUE_DROP_TENANTS, 100, 1);
const CHUNK = intOf(env.QUEUE_DROP_CHUNK, 50_000, 1_000);
const LIMIT_S = Number(env.QUEUE_DROP_LIMIT_S ?? 60);
const DRAIN_TIMEOUT_MIN = Number(env.QUEUE_DROP_DRAIN_TIMEOUT_MIN ?? 30);
const POLL_S = intOf(env.QUEUE_DROP_POLL_S, 5, 1);
const OUT = resolve(env.QUEUE_DROP_OUT ?? "tests/load/results/queue-drop.json");

const FAMILY = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const RUN = `queue-drop-${Date.now().toString(36)}`;

/** The seed's uuid v7 at an instant (seed-tiers/00-setup.sql). */
const UUID7 = `
  CREATE OR REPLACE FUNCTION pg_temp.qd_uuid7(at timestamp) RETURNS text
  LANGUAGE sql VOLATILE AS $$
    SELECT substr(k.h, 1, 8) || '-' || substr(k.h, 9, 4) || '-7' ||
           substr(k.r, 1, 3) || '-8' || substr(k.r, 4, 3) || '-' ||
           substr(k.r, 7, 12)
    FROM (
      SELECT lpad(to_hex((extract(epoch FROM at) * 1000)::bigint), 12, '0') AS h,
             md5(random()::text) AS r
    ) AS k
  $$;
`;

/** The schema's timestamps: UTC, without a zone. */
const NOW = `(now() AT TIME ZONE 'UTC')`;

const stampOf = (ms) =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
const dayOfStamp = (stamp) =>
  Date.parse(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z`,
  );

function startOfTodayUtc(now = Date.now()) {
  const at = new Date(now);

  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** The day partitions every table of the family has, by stamp. */
async function familyDays(client) {
  const { rows } = await client.query(
    `
    SELECT p.relname AS parent, substr(c.relname, length(p.relname) + 2) AS stamp
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ANY($1::text[])
      AND c.relname ~ ('^' || p.relname || '_[0-9]{8}$')
    `,
    [FAMILY],
  );
  const counts = new Map();

  for (const row of rows)
    counts.set(row.stamp, (counts.get(row.stamp) ?? 0) + 1);

  return [...counts]
    .filter(([, tables]) => tables === FAMILY.length)
    .map(([stamp]) => stamp)
    .sort();
}

/**
 * QUEUE_DROP_DAY, or the oldest day before yesterday, or the newest from
 * the day after tomorrow: never one the API writes into now.
 */
function chooseDay(days, today = startOfTodayUtc()) {
  if (env.QUEUE_DROP_DAY) {
    const stamp = env.QUEUE_DROP_DAY.replace(/-/g, "");

    if (!/^\d{8}$/.test(stamp) || !days.includes(stamp)) {
      throw new Error(
        `QUEUE_DROP_DAY=${env.QUEUE_DROP_DAY} não tem partição nas três tabelas da família (há: ${days.join(", ") || "nenhuma"}).`,
      );
    }

    const day = dayOfStamp(stamp);

    if (day >= today - DAY_MS && day <= today + DAY_MS) {
      throw new Error(
        `QUEUE_DROP_DAY=${env.QUEUE_DROP_DAY} é ontem, hoje ou amanhã: a API grava nesses dias.`,
      );
    }

    return stamp;
  }

  const past = days.filter((stamp) => dayOfStamp(stamp) < today - DAY_MS);
  const future = days.filter((stamp) => dayOfStamp(stamp) > today + DAY_MS);

  if (past.length > 0) return past[0];
  if (future.length > 0) return future[future.length - 1];

  throw new Error(
    "Nenhum dia de partição fora de ontem, hoje e amanhã nas filas: suba o harness com a troca das filas feita (o migrate do harness a faz) ou passe QUEUE_DROP_DAY.",
  );
}

/** The run's rows of one kind, written in chunks of CHUNK. */
async function inChunks(client, total, write) {
  for (let from = 1; from <= total; from += CHUNK) {
    const to = Math.min(total, from + CHUNK - 1);

    await client.query("BEGIN");
    await write(from, to);
    await client.query("COMMIT");
  }
}

async function writeDay(client, dayStart) {
  await client.query(UUID7);

  await client.query(`
    CREATE TEMP TABLE qd_recipient AS
    SELECT s.user_id, s.business_id,
           (row_number() OVER (ORDER BY s.user_id) - 1)::int AS k
    FROM (
      SELECT DISTINCT ON (u."businessId") u.id AS user_id,
             u."businessId" AS business_id
      FROM "user" u
      WHERE u.role = 'BUSINESS_ADMIN' AND u."businessId" IS NOT NULL
      ORDER BY u."businessId", u.id
      LIMIT ${TENANTS}
    ) s
  `);

  const {
    rows: [{ n: tenants }],
  } = await client.query(`SELECT count(*)::int AS n FROM qd_recipient`);

  if (tenants === 0) {
    throw new Error(
      "Nenhuma empresa com BUSINESS_ADMIN no banco: rode o seed.ts antes (README, Como rodar).",
    );
  }

  await client.query(`
    CREATE TEMP TABLE qd_pending (id text PRIMARY KEY);
    CREATE TEMP TABLE qd_delivery (id text PRIMARY KEY);
  `);

  const day = new Date(dayStart).toISOString().slice(0, 10);
  const payload = `jsonb_build_object(
    'type', 'Carga', 'action', 'queue-drop',
    'entityId', gen_random_uuid()::text,
    'description', 'Evento do DROP sob carga ' || $1,
    'status', 'Criado')`;

  // The settled day: published events with their keys and their activity,
  // the first FAILED of them failed for good.
  await inChunks(client, EVENTS, (from, to) =>
    client.query(
      `
      WITH ev AS (
        SELECT n, $2::date::timestamp + random() * interval '86399 seconds' AS at
        FROM generate_series($3::int, $4::int) AS n
      ),
      inserted AS (
        INSERT INTO "domain_outbox_event" (
          "id", "eventKey", "topic", "aggregateType", "aggregateId",
          "businessId", "actorId", "payload", "status", "availableAt",
          "attempts", "processedAt", "lastError", "created_at", "updated_at"
        )
        SELECT pg_temp.qd_uuid7(ev.at), $1 || ':s:' || ev.n, 'activity.recorded',
               'queue-drop', gen_random_uuid()::text, r.business_id, r.user_id,
               ${payload},
               (CASE WHEN ev.n <= $5::int THEN 'FAILED' ELSE 'PUBLISHED' END)::"OutboxEventStatus",
               ev.at, CASE WHEN ev.n <= $5::int THEN 5 ELSE 1 END,
               CASE WHEN ev.n <= $5::int THEN NULL ELSE ev.at + interval '1 second' END,
               CASE WHEN ev.n <= $5::int THEN 'falha da cena do DROP' ELSE NULL END,
               ev.at, ev.at
        FROM ev JOIN qd_recipient r ON r.k = ev.n % $6::int
        RETURNING "id", "eventKey", "businessId", "actorId", "created_at", "status"
      ),
      keys AS (
        INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
        SELECT "eventKey", "id", "created_at" FROM inserted
      ),
      deliveries AS (
        INSERT INTO "notification_delivery" (
          "id", "outboxEventId", "userId", "channel", "status", "attempts",
          "availableAt", "deliveredAt", "created_at", "updated_at", "business_id"
        )
        SELECT pg_temp.qd_uuid7(i."created_at"), i."id", i."actorId", 'ACTIVITY',
               'DELIVERED', 1, i."created_at", i."created_at", i."created_at",
               i."created_at", i."businessId"
        FROM inserted i
        WHERE i."status" = 'PUBLISHED'
        RETURNING "id"
      )
      INSERT INTO qd_delivery SELECT "id" FROM deliveries
      `,
      [RUN, day, from, to, FAILED, tenants],
    ),
  );

  // The providers' receipts of some of them, in the same day (a receipt's
  // id carries its delivery's millisecond).
  if (RECEIPTS > 0) {
    await client.query(
      `
      INSERT INTO "notification_provider_receipt" (
        "id", "deliveryId", "provider", "providerMessageId", "status",
        "occurredAt", "created_at"
      )
      SELECT pg_temp.qd_uuid7(
               to_timestamp(('x' || replace(substr(d."id", 1, 13), '-', ''))::bit(48)::bigint / 1000.0)
               AT TIME ZONE 'UTC'),
             d."id", 'resend', $1 || ':r:' || d."id", 'delivered', ${NOW}, ${NOW}
      FROM (SELECT "id" FROM qd_delivery LIMIT $2::int) d
      `,
      [RUN, RECEIPTS],
    );
  }

  // The day's drain: events still to expand, due now.
  if (PENDING > 0) {
    await inChunks(client, PENDING, (from, to) =>
      client.query(
        `
        WITH ev AS (
          SELECT n, $2::date::timestamp + random() * interval '86399 seconds' AS at
          FROM generate_series($3::int, $4::int) AS n
        ),
        inserted AS (
          INSERT INTO "domain_outbox_event" (
            "id", "eventKey", "topic", "aggregateType", "aggregateId",
            "businessId", "actorId", "payload", "status", "availableAt",
            "attempts", "created_at", "updated_at"
          )
          SELECT pg_temp.qd_uuid7(ev.at), $1 || ':p:' || ev.n, 'activity.recorded',
                 'queue-drop', gen_random_uuid()::text, r.business_id, r.user_id,
                 ${payload}, 'PENDING', ${NOW}, 0, ev.at, ev.at
          FROM ev JOIN qd_recipient r ON r.k = ev.n % $5::int
          RETURNING "id", "eventKey", "created_at"
        ),
        keys AS (
          INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
          SELECT "eventKey", "id", "created_at" FROM inserted
        )
        INSERT INTO qd_pending SELECT "id" FROM inserted
        `,
        [RUN, day, from, to, tenants],
      ),
    );
  }

  return tenants;
}

/** What of the day is still in flight, read on the day's own partitions. */
async function inFlightOf(client, stamp) {
  const {
    rows: [row],
  } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM "domain_outbox_event_${stamp}"
        WHERE "status" IN ('PENDING', 'PROCESSING')) AS events,
      (SELECT count(*)::int FROM "notification_delivery_${stamp}"
        WHERE "status" IN ('PENDING', 'PROCESSING')) AS deliveries,
      (SELECT count(*)::int FROM "domain_outbox_event" e JOIN qd_pending p USING ("id")
        WHERE e."status" = 'FAILED') AS failed
  `);

  return row;
}

async function partitionsLeft(client, stamp) {
  const { rows } = await client.query(
    `SELECT t AS "table", to_regclass(quote_ident(t || '_' || $1::text)) IS NOT NULL AS present
     FROM unnest($2::text[]) AS t`,
    [stamp, FAMILY],
  );

  return Object.fromEntries(rows.map((row) => [row.table, row.present]));
}

/**
 * The app's modules on this process's env. Every database URL the app
 * could take from the repository's .env is pinned first to the disposable
 * one (dotenv never overrides a variable that is set).
 */
async function appModules() {
  for (const name of [
    "BATCH_DATABASE_URL",
    "DATABASE_READ_URL",
    "READINESS_DATABASE_URL",
  ]) {
    env[name] = env.DATABASE_URL;
  }

  for (const name of ["DATABASE_REPLICA_URL", "PGBOUNCER_STATS_URL"]) {
    env[name] = "";
  }

  await import("reflect-metadata");

  const [{ maintainPartitions }, partitions, family, database, appEnv] =
    await Promise.all([
      import("../../src/jobs/cron/partition-maintenance-job.ts"),
      import("../../src/shared/database/partitions.ts"),
      import("../../src/shared/notifications/notification-family-retention.ts"),
      import("../../infra/database.ts"),
      import("../../src/env/index.ts"),
    ]);

  return {
    maintainPartitions,
    registeredPartitions: partitions.registeredPartitions,
    createNotificationFamilyGate: family.createNotificationFamilyGate,
    databaseBatch: database.databaseBatch,
    disconnect: async () => {
      await Promise.allSettled(
        [database.default, database.databaseBatch].map((client) =>
          client?.$disconnect?.(),
        ),
      );
    },
    failedRetentionDays: appEnv.env.OUTBOX_FAILED_RETENTION_DAYS,
  };
}

async function main() {
  assertDisposableDatabase(env.DATABASE_URL, env);

  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  await client.connect();

  let app = null;

  try {
    const stamp = chooseDay(await familyDays(client));
    const dayStart = dayOfStamp(stamp);

    console.log(
      `DROP ${RUN}: o dia ${stamp}, ${EVENTS} eventos (${FAILED} FAILED), ${PENDING} pendentes, ${RECEIPTS} recibos...`,
    );

    const fillStarted = Date.now();
    const tenants = await writeDay(client, dayStart);
    const fillSeconds = (Date.now() - fillStarted) / 1000;

    await client.query("ANALYZE qd_pending; ANALYZE qd_delivery");

    console.log(
      `DROP ${RUN}: gravado em ${Math.round(fillSeconds)} s, em ${tenants} empresas; esperando o dreno do dia`,
    );

    // The drain of the day: the harness' pipeline expands and delivers.
    const drainStarted = Date.now();
    let flight = await inFlightOf(client, stamp);

    while (flight.events > 0 || flight.deliveries > 0) {
      if (Date.now() - drainStarted > DRAIN_TIMEOUT_MIN * 60_000) break;

      await new Promise((done) => setTimeout(done, POLL_S * 1000));
      flight = await inFlightOf(client, stamp);
      console.log(
        `  ${Math.round((Date.now() - drainStarted) / 1000)}s: ${flight.events} eventos e ${flight.deliveries} entregas do dia em voo`,
      );
    }

    const drainSeconds = (Date.now() - drainStarted) / 1000;
    const drained = flight.events === 0 && flight.deliveries === 0;
    const reasons = [];
    let dropSeconds = null;
    let outcome = null;
    let left = await partitionsLeft(client, stamp);
    let deadLetters = 0;
    let missingNow = null;
    let window = null;

    if (!drained) {
      reasons.push(
        `o dia não drenou em ${DRAIN_TIMEOUT_MIN} min: o harness consome a fila outbox e a raia internal?`,
      );
    } else {
      app = await appModules();

      // The day's end is the retention's cutoff: this day is past it, the
      // next one is not.
      const today = startOfTodayUtc();
      const retentionDays = Math.round((today - (dayStart + DAY_MS)) / DAY_MS);
      const tables = app
        .registeredPartitions()
        .filter((table) => FAMILY.includes(table.table))
        .map((table) => ({ ...table, retentionDays }));
      const gate = app.createNotificationFamilyGate({
        db: app.databaseBatch,
        deadline: Date.now() + 10 * 60_000,
        failedRetentionDays: app.failedRetentionDays,
      });
      const thisDayOnly = {
        mayDrop: (parent, partition) =>
          partition.name === `${parent}_${stamp}`
            ? gate.mayDrop(parent, partition)
            : Promise.resolve(false),
      };

      const from = new Date();
      const started = Date.now();

      outcome = await app.maintainPartitions({
        tables,
        dropGates: {
          "notification-family": thisDayOnly,
          "webhook-deliveries": { mayDrop: async () => false },
        },
        trailArchive: null,
        historyArchive: null,
        historyDrop: null,
      });

      dropSeconds = (Date.now() - started) / 1000;
      window = { from: from.toISOString(), to: new Date().toISOString() };
      console.log(`QUEUE_DROP_WINDOW ${JSON.stringify(window)}`);

      left = await partitionsLeft(client, stamp);

      const {
        rows: [dead],
      } = await client.query(
        `SELECT count(*)::int AS n FROM "outbox_event_dead_letter" WHERE "eventKey" LIKE $1`,
        [`${RUN}:s:%`],
      );

      deadLetters = dead.n;

      for (const [table, present] of Object.entries(left)) {
        if (present)
          reasons.push(`a partição ${table}_${stamp} continua no banco`);
      }

      if (FAILED > 0 && deadLetters < FAILED) {
        reasons.push(
          `só ${deadLetters} de ${FAILED} eventos FAILED foram para o dead letter`,
        );
      }

      if (dropSeconds >= LIMIT_S) {
        reasons.push(
          `o DROP levou ${Math.round(dropSeconds)} s (limite ${LIMIT_S} s)`,
        );
      }

      // The night again, with the real retention: every day a row may land
      // in now is there (a future day dropped inside the lookahead comes
      // back; one past it comes when the lookahead reaches it).
      const restored = await app.maintainPartitions({
        tables: app
          .registeredPartitions()
          .filter((table) => FAMILY.includes(table.table)),
        trailArchive: null,
        historyArchive: null,
        historyDrop: null,
      });

      missingNow = Object.fromEntries(
        Object.entries(restored).map(([table, each]) => [
          table,
          each.missingNow,
        ]),
      );

      for (const [table, missing] of Object.entries(missingNow)) {
        if (missing.length > 0) {
          reasons.push(
            `${table} sem a partição de que precisa agora: ${missing.join(", ")}`,
          );
        }
      }
    }

    if (flight.failed > 0) {
      reasons.push(
        `${flight.failed} evento(s) pendente(s) do dia terminaram FAILED`,
      );
    }

    const summary = {
      run: RUN,
      day: stamp,
      rows: {
        events: EVENTS,
        failed: FAILED,
        pending: PENDING,
        receipts: RECEIPTS,
      },
      tenants,
      fillSeconds: Math.round(fillSeconds),
      drained,
      drainSeconds: Math.round(drainSeconds),
      dropSeconds: dropSeconds === null ? null : Number(dropSeconds.toFixed(1)),
      limitSeconds: LIMIT_S,
      window,
      partitionsLeft: left,
      deadLetters,
      missingNow,
      outcome,
      pass: reasons.length === 0,
      reasons,
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(JSON.stringify(summary, null, 2));
    console.log(`resumo em ${OUT}`);

    process.exitCode = summary.pass ? 0 : 1;
  } finally {
    await client.end();
    await app?.disconnect();
  }
}

await main();
