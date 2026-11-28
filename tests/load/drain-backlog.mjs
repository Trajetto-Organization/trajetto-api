#!/usr/bin/env node
/**
 * The drain of a backlog (plano-escala LOAD-04; the acceptance of the 100k
 * and 1M gates: 50 000 outbox events plus 20 000 notifications drained in
 * under 15 minutes, with the HTTP in p95 under 300 ms meanwhile).
 *
 * A backlog is what a worker finds after a deploy that stopped it, a
 * database that paused, or a carrier's import: the queues full and due at
 * once. This script writes one by SQL into the harness' load_test, as the
 * seed writes its rows (ids minted as uuid v7 at the instant, the day's
 * partition of each queue):
 *
 *  - DRAIN_EVENTS (50 000) PENDING `activity.recorded` events, spread over
 *    DRAIN_TENANTS (100) companies, each from the company's admin: the
 *    expansion turns each into an ACTIVITY delivery, a write into our own
 *    database, so the drain calls no provider (nothing of a load run may
 *    leave the machine);
 *  - DRAIN_NOTIFICATIONS (20 000) PENDING IN_APP deliveries of already
 *    expanded bills, to the same admins: the bell's rows and the socket
 *    events.
 *
 * Then it watches the run's rows until none is PENDING or PROCESSING, and
 * writes the summary (DRAIN_OUT, tests/load/results/drain-backlog.json):
 * how long the drain took, the minute by minute progress, the rows that
 * FAILED (must be 0) and the verdict against DRAIN_LIMIT_MIN (15). The
 * HTTP side runs beside it, load.js with its summary-export, and
 * lib/verdicts.mjs `drain` judges the two together (README, "As cenas de
 * fila e importação"). Whoever drains is the harness: the replicas in
 * PROCESS_ROLE=all, or the worker with `--profile roles`.
 *
 * Only into the disposable database (lib/disposable-database.ts: 54321 or
 * LOAD_PG_PORT, on localhost). Run with tsx, which reads that guard:
 *
 *   DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
 *     npx tsx tests/load/drain-backlog.mjs
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

const EVENTS = intOf(env.DRAIN_EVENTS, 50_000);
const NOTIFICATIONS = intOf(env.DRAIN_NOTIFICATIONS, 20_000);
const TENANTS = intOf(env.DRAIN_TENANTS, 100, 1);
const LIMIT_MIN = Number(env.DRAIN_LIMIT_MIN ?? 15);
const TIMEOUT_MIN = Number(env.DRAIN_TIMEOUT_MIN ?? 30);
const POLL_S = intOf(env.DRAIN_POLL_S, 5, 1);
const OUT = resolve(env.DRAIN_OUT ?? "tests/load/results/drain-backlog.json");

const RUN = `drain-${Date.now().toString(36)}`;

/** The seed's uuid v7 at an instant (seed-tiers/00-setup.sql). */
const UUID7 = `
  CREATE OR REPLACE FUNCTION pg_temp.drain_uuid7(at timestamp) RETURNS text
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

/** The timestamps of the schema: UTC, without a zone. */
const NOW = `(now() AT TIME ZONE 'UTC')`;

async function writeBacklog(client) {
  await client.query(UUID7);

  // A utility statement takes no bind parameter: TENANTS is an integer.
  await client.query(`
    CREATE TEMP TABLE drain_recipient AS
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
  } = await client.query(`SELECT count(*)::int AS n FROM drain_recipient`);

  if (tenants === 0) {
    throw new Error(
      "Nenhuma empresa com BUSINESS_ADMIN no banco: rode o seed.ts antes (README, Como rodar).",
    );
  }

  await client.query(`
    CREATE TEMP TABLE drain_event (id text PRIMARY KEY);
    CREATE TEMP TABLE drain_delivery (id text PRIMARY KEY);
  `);

  await client.query("BEGIN");

  // The events the expansion takes: one ACTIVITY each, for its actor.
  await client.query(
    `
    WITH inserted AS (
      INSERT INTO "domain_outbox_event" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "status", "availableAt",
        "attempts", "created_at", "updated_at"
      )
      SELECT pg_temp.drain_uuid7(${NOW}), $1 || ':e:' || n, 'activity.recorded',
             'drain', gen_random_uuid()::text, r.business_id, r.user_id,
             jsonb_build_object(
               'type', 'Carga', 'action', 'drain',
               'entityId', gen_random_uuid()::text,
               'description', 'Evento do dreno da carga ' || $1,
               'status', 'Criado'
             ),
             'PENDING', ${NOW}, 0, ${NOW}, ${NOW}
      FROM generate_series(1, $2::int) AS n
      JOIN drain_recipient r ON r.k = n % $3::int
      RETURNING "id", "eventKey", "created_at"
    ),
    keys AS (
      INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
      SELECT "eventKey", "id", "created_at" FROM inserted
    )
    INSERT INTO drain_event SELECT "id" FROM inserted
    `,
    [RUN, EVENTS, tenants],
  );

  // The notifications already expanded: one IN_APP each, due now.
  await client.query(
    `
    WITH published AS (
      INSERT INTO "domain_outbox_event" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "status", "availableAt",
        "attempts", "processedAt", "created_at", "updated_at"
      )
      SELECT pg_temp.drain_uuid7(${NOW}), $1 || ':n:' || n,
             'account-payable.created', 'account-payable',
             gen_random_uuid()::text, r.business_id, r.user_id,
             jsonb_build_object(
               'accountPayableId', gen_random_uuid()::text,
               'businessId', r.business_id, 'amount', 150,
               'serviceOrderId', NULL, 'registrationUserId', r.user_id
             ),
             'PUBLISHED', ${NOW}, 1, ${NOW}, ${NOW}, ${NOW}
      FROM generate_series(1, $2::int) AS n
      JOIN drain_recipient r ON r.k = n % $3::int
      RETURNING "id", "eventKey", "businessId", "actorId", "created_at"
    ),
    keys AS (
      INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
      SELECT "eventKey", "id", "created_at" FROM published
    ),
    deliveries AS (
      INSERT INTO "notification_delivery" (
        "id", "outboxEventId", "userId", "channel", "status", "attempts",
        "availableAt", "created_at", "updated_at", "business_id"
      )
      SELECT pg_temp.drain_uuid7(${NOW}), p."id", p."actorId", 'IN_APP',
             'PENDING', 0, ${NOW}, ${NOW}, ${NOW}, p."businessId"
      FROM published p
      RETURNING "id"
    )
    INSERT INTO drain_delivery SELECT "id" FROM deliveries
    `,
    [RUN, NOTIFICATIONS, tenants],
  );

  await client.query("COMMIT");

  await client.query("ANALYZE drain_event; ANALYZE drain_delivery");

  return tenants;
}

/** What is left of the run, and what failed. */
async function progressOf(client) {
  const {
    rows: [row],
  } = await client.query(`
    SELECT
      count(*) FILTER (WHERE e."status" IN ('PENDING', 'PROCESSING'))::int AS events_left,
      count(*) FILTER (WHERE e."status" = 'FAILED')::int AS events_failed,
      (SELECT count(*) FILTER (WHERE d."status" IN ('PENDING', 'PROCESSING'))::int
         FROM "notification_delivery" d
         WHERE d."outboxEventId" IN (SELECT id FROM drain_event)) AS expanded_left,
      (SELECT count(*)::int
         FROM "notification_delivery" d
         WHERE d."outboxEventId" IN (SELECT id FROM drain_event)) AS expanded,
      (SELECT count(*) FILTER (WHERE d."status" = 'FAILED')::int
         FROM "notification_delivery" d
         WHERE d."outboxEventId" IN (SELECT id FROM drain_event)) AS expanded_failed,
      (SELECT count(*) FILTER (WHERE d."status" IN ('PENDING', 'PROCESSING'))::int
         FROM "notification_delivery" d JOIN drain_delivery x USING ("id")) AS notifications_left,
      (SELECT count(*) FILTER (WHERE d."status" = 'FAILED')::int
         FROM "notification_delivery" d JOIN drain_delivery x USING ("id")) AS notifications_failed
    FROM "domain_outbox_event" e JOIN drain_event x USING ("id")
  `);

  return row;
}

function drained(progress) {
  return (
    progress.events_left === 0 &&
    progress.expanded_left === 0 &&
    progress.notifications_left === 0
  );
}

async function main() {
  assertDisposableDatabase(env.DATABASE_URL, env);

  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  await client.connect();

  try {
    console.log(
      `dreno ${RUN}: ${EVENTS} eventos e ${NOTIFICATIONS} notificações...`,
    );

    const tenants = await writeBacklog(client);
    const startedAt = new Date();
    const timeline = [];
    let last = await progressOf(client);

    console.log(
      `dreno ${RUN}: gravado em ${tenants} empresas às ${startedAt.toISOString()}; acompanhando a cada ${POLL_S} s`,
    );

    while (!drained(last)) {
      const elapsed = (Date.now() - startedAt.getTime()) / 1000;

      if (elapsed > TIMEOUT_MIN * 60) break;

      await new Promise((done) => setTimeout(done, POLL_S * 1000));

      last = await progressOf(client);

      const point = {
        seconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        ...last,
      };

      timeline.push(point);
      console.log(
        `  ${point.seconds}s: eventos ${last.events_left}, atividades ${last.expanded_left}, notificações ${last.notifications_left}`,
      );
    }

    const done = drained(last);
    const drainSeconds = (Date.now() - startedAt.getTime()) / 1000;
    const failed =
      last.events_failed + last.expanded_failed + last.notifications_failed;
    const reasons = [];

    if (!done) {
      reasons.push(`não drenou em ${TIMEOUT_MIN} min`);
    } else if (drainSeconds > LIMIT_MIN * 60) {
      reasons.push(
        `drenou em ${Math.round(drainSeconds / 60)} min (limite ${LIMIT_MIN} min)`,
      );
    }

    if (failed > 0) reasons.push(`${failed} linha(s) FAILED`);

    if (done && last.expanded < EVENTS) {
      reasons.push(
        `só ${last.expanded} de ${EVENTS} eventos viraram atividade`,
      );
    }

    const summary = {
      run: RUN,
      events: EVENTS,
      notifications: NOTIFICATIONS,
      tenants,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      drained: done,
      drainSeconds: Math.round(drainSeconds),
      limitMinutes: LIMIT_MIN,
      rowsPerSecond: Math.round((EVENTS * 2 + NOTIFICATIONS) / drainSeconds),
      failed: {
        events: last.events_failed,
        activities: last.expanded_failed,
        notifications: last.notifications_failed,
      },
      timeline,
      pass: reasons.length === 0,
      reasons,
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(JSON.stringify({ ...summary, timeline: undefined }, null, 2));
    console.log(`resumo em ${OUT}`);

    process.exitCode = summary.pass ? 0 : 1;
  } finally {
    await client.end();
  }
}

await main();
