import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import pg from "pg";
import { container } from "tsyringe";

import { assertDisposableDatabase } from "./lib/disposable-database";

/**
 * One company's flood of external messages, and the others' wait
 * (plano-escala LOAD-04; the acceptance of the fair claims of wave 13:
 * with 20 000 messages of one tenant on the external lane, the other
 * tenants' external messages go out in p95 under 60 s).
 *
 * The external lane waits on Meta and on the e-mail provider. A carrier
 * that fires twenty thousand notices at once used to put every other
 * company's message behind them: the claim took the oldest first, and the
 * oldest were all theirs. With QUEUE_FAIR_CLAIM_ENABLED=true the claim
 * takes the rows company by company (F3-10); this scene measures what the
 * other companies feel.
 *
 * Why a process of its own, and not the harness' image: the image's
 * providers have their hosts written in the code (graph.facebook.com over
 * TLS), so a fake provider of 300 ms cannot stand behind it without a
 * route or a certificate that production would carry too. This process
 * runs the real NotificationPipelineService of this tree on the external
 * lane, against the harness' load_test and Redis, with a fake WhatsApp
 * provider that answers in FLOOD_PROVIDER_MS (300), as the E2E do. The
 * harness must not claim the external lane meanwhile: LOAD_API_ROLE=api,
 * and with the roles profile LOAD_WORKER_QUEUES=outbox,internal,webhooks,ai
 * (README, "As cenas de fila e importação").
 *
 * The flood is written by SQL, already expanded: FLOOD_MESSAGES (20 000)
 * WhatsApp deliveries to the flooding company's admin, due now. During
 * FLOOD_DURATION_MIN (10), each of FLOOD_OTHERS (20) other companies gets
 * one WhatsApp every FLOOD_OTHER_EVERY_S (5) seconds. The summary
 * (FLOOD_OUT, tests/load/results/queue-flood.json) has the others' wait
 * (deliveredAt − created_at), the flood's throughput and the verdict
 * against FLOOD_P95_LIMIT_S (60).
 *
 * Only into the disposable database (lib/disposable-database.ts):
 *
 *   NODE_ENV=test QUEUE_FAIR_CLAIM_ENABLED=true \
 *     DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
 *     REDIS_URL=redis://localhost:56379 npx tsx tests/load/queue-flood.ts
 */

const env = process.env;

function intOf(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Math.floor(Number(value));

  return Number.isFinite(parsed) && value !== undefined && value !== ""
    ? Math.max(min, parsed)
    : fallback;
}

const MESSAGES = intOf(env.FLOOD_MESSAGES, 20_000);
const OTHERS = intOf(env.FLOOD_OTHERS, 20, 1);
const OTHER_EVERY_S = intOf(env.FLOOD_OTHER_EVERY_S, 5, 1);
const DURATION_MIN = Number(env.FLOOD_DURATION_MIN ?? 10);
const GRACE_MIN = Number(env.FLOOD_GRACE_MIN ?? 5);
const PROVIDER_MS = intOf(env.FLOOD_PROVIDER_MS, 300);
const P95_LIMIT_S = Number(env.FLOOD_P95_LIMIT_S ?? 60);
const OUT = resolve(env.FLOOD_OUT ?? "tests/load/results/queue-flood.json");
const CONTEXT = resolve(
  env.FLOOD_CONTEXT ?? "tests/load/fixtures/load-context.json",
);

const RUN = `flood-${Date.now().toString(36)}`;

/** The seed's uuid v7 at an instant (seed-tiers/00-setup.sql). */
const UUID7 = `
  CREATE OR REPLACE FUNCTION pg_temp.flood_uuid7(at timestamp) RETURNS text
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

type Kind = "flood" | "other";

interface Recipient {
  user_id: string;
  business_id: string;
}

/** The flooding company: FLOOD_BUSINESS_ID, or the fixture's primary. */
function floodingCompany(): string | null {
  if (env.FLOOD_BUSINESS_ID) return env.FLOOD_BUSINESS_ID;

  if (!existsSync(CONTEXT)) return null;

  const context = JSON.parse(readFileSync(CONTEXT, "utf8")) as {
    businessId?: string;
  };

  return context.businessId ?? null;
}

/**
 * `count` WhatsApp deliveries to `recipient`, due now, each with its
 * already published event (a bill to the admin, the E2E's topic), and the
 * run's note of each in flood_row.
 */
async function writeMessages(
  client: pg.Client,
  recipient: Recipient,
  count: number,
  kind: Kind,
): Promise<number> {
  const { rowCount } = await client.query(
    `
    WITH published AS (
      INSERT INTO "domain_outbox_event" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "status", "availableAt",
        "attempts", "processedAt", "created_at", "updated_at"
      )
      SELECT pg_temp.flood_uuid7(${NOW}), $1 || ':' || gen_random_uuid()::text,
             'account-payable.created', 'account-payable',
             gen_random_uuid()::text, $2, $3,
             jsonb_build_object(
               'accountPayableId', gen_random_uuid()::text,
               'businessId', $2::text, 'amount', 150,
               'serviceOrderId', NULL, 'registrationUserId', $3::text
             ),
             'PUBLISHED', ${NOW}, 1, ${NOW}, ${NOW}, ${NOW}
      FROM generate_series(1, $4::int) AS n
      RETURNING "id", "eventKey", "created_at"
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
      SELECT pg_temp.flood_uuid7(${NOW}), p."id", $3, 'WHATSAPP', 'PENDING',
             0, ${NOW}, ${NOW}, ${NOW}, $2
      FROM published p
      RETURNING "id"
    )
    INSERT INTO flood_row SELECT "id", $5 FROM deliveries
    `,
    [`${RUN}:${kind}`, recipient.business_id, recipient.user_id, count, kind],
  );

  return rowCount ?? 0;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;

  const index = Math.ceil((p / 100) * sorted.length) - 1;

  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  assertDisposableDatabase(env.DATABASE_URL, env);

  const flooding = floodingCompany();

  if (!flooding) {
    throw new Error(
      "Sem a empresa da enchente: defina FLOOD_BUSINESS_ID ou rode o seed.ts (fixtures/load-context.json).",
    );
  }

  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  await client.connect();
  await client.query(UUID7);

  // The run's rows, by kind: what the counts below join on.
  await client.query(
    `CREATE TEMP TABLE flood_row (id text PRIMARY KEY, kind text NOT NULL)`,
  );

  // One admin per company: the flooding one and FLOOD_OTHERS others.
  const { rows: admins } = await client.query<Recipient>(`
    SELECT DISTINCT ON (u."businessId") u.id AS user_id,
           u."businessId" AS business_id
    FROM "user" u
    WHERE u.role = 'BUSINESS_ADMIN' AND u."businessId" IS NOT NULL
    ORDER BY u."businessId", u.id
  `);

  const flooder = admins.find((admin) => admin.business_id === flooding);
  const others = admins
    .filter((admin) => admin.business_id !== flooding)
    .slice(0, OTHERS);

  if (!flooder || others.length === 0) {
    throw new Error(
      "O banco precisa da empresa da enchente e de outras com BUSINESS_ADMIN: rode o seed.ts com LOAD_TENANTS ≥ 2.",
    );
  }

  // The admins get WhatsApp, in the disposable database only.
  await client.query(
    `
    UPDATE "user"
    SET "whatsapp_phone" = '55119' || lpad((abs(hashtext(id)) % 100000000)::text, 8, '0'),
        "whatsapp_notifications_enabled" = true
    WHERE id = ANY($1::text[])
    `,
    [[flooder, ...others].map((admin) => admin.user_id)],
  );

  // The app's modules, on this process's env (the harness' database and
  // Redis), and the fake Meta registered after them: the last one wins.
  await import("@/shared");

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () => {
      await pause(PROVIDER_MS);

      return { success: true, messageId: `wamid.${randomUUID()}` };
    },
  });

  const { NotificationPipelineService } =
    await import("@/shared/notifications/notification-pipeline-service");

  const pipeline = NotificationPipelineService.getInstance();

  console.log(
    `enchente ${RUN}: ${MESSAGES} mensagens de ${flooding}, ${others.length} outras empresas a cada ${OTHER_EVERY_S} s por ${DURATION_MIN} min; provedor falso de ${PROVIDER_MS} ms; QUEUE_FAIR_CLAIM_ENABLED=${env.QUEUE_FAIR_CLAIM_ENABLED ?? "false"}`,
  );

  const floodCount = await writeMessages(client, flooder, MESSAGES, "flood");
  const startedAt = Date.now();

  // The other companies' messages, one each per tick, while the flood runs.
  const trickle = setInterval(() => {
    void Promise.all(
      others.map((admin) => writeMessages(client, admin, 1, "other")),
    ).catch((error) => console.error("falha ao gravar uma mensagem", error));
  }, OTHER_EVERY_S * 1000);

  let stopping = false;

  // The lane, as a worker runs it: a cycle drains what is due, and the
  // sweep starts the next one.
  const lane = (async () => {
    while (!stopping) {
      await pipeline.runDeliveryCycle("external");
      await pause(500);
    }
  })();

  const progress = setInterval(() => {
    void client
      .query<{ flood: number; others: number; written: number }>(
        `
        SELECT
          count(*) FILTER (WHERE r.kind = 'flood' AND d."status" = 'DELIVERED')::int AS flood,
          count(*) FILTER (WHERE r.kind = 'other' AND d."status" = 'DELIVERED')::int AS others,
          count(*) FILTER (WHERE r.kind = 'other')::int AS written
        FROM flood_row r JOIN "notification_delivery" d USING ("id")
        `,
      )
      .then(({ rows: [row] }) => {
        console.log(
          `  ${Math.round((Date.now() - startedAt) / 1000)}s: enchente ${row.flood}/${floodCount}, outras ${row.others}/${row.written}`,
        );
      })
      .catch(() => undefined);
  }, 30_000);

  await pause(DURATION_MIN * 60_000);
  clearInterval(trickle);

  // The others' last messages may still be in the queue: a grace for them,
  // never for the flood.
  const graceEnd = Date.now() + GRACE_MIN * 60_000;

  for (;;) {
    const {
      rows: [row],
    } = await client.query<{ left: number }>(`
      SELECT count(*)::int AS left
      FROM flood_row r JOIN "notification_delivery" d USING ("id")
      WHERE r.kind = 'other' AND d."status" <> 'DELIVERED'
    `);

    if (row.left === 0 || Date.now() > graceEnd) break;

    await pause(2_000);
  }

  stopping = true;
  clearInterval(progress);
  await pipeline.shutdown({ deadlineMs: 15_000 });
  await lane.catch(() => undefined);

  // created_at is the row's insertion: the claim moves availableAt to the
  // lease's end, so the wait counts from creation — what the company
  // waited, flood or no flood.
  const { rows: waits } = await client.query<{
    seconds: number | null;
    status: string;
  }>(`
    SELECT extract(epoch FROM (d."deliveredAt" - d."created_at"))::float AS seconds,
           d."status"
    FROM flood_row r JOIN "notification_delivery" d USING ("id")
    WHERE r.kind = 'other'
  `);

  const {
    rows: [flood],
  } = await client.query<{ delivered: number; failed: number }>(`
    SELECT count(*) FILTER (WHERE d."status" = 'DELIVERED')::int AS delivered,
           count(*) FILTER (WHERE d."status" = 'FAILED')::int AS failed
    FROM flood_row r JOIN "notification_delivery" d USING ("id")
    WHERE r.kind = 'flood'
  `);

  await client.end();

  const delivered = waits.filter(
    (row) => row.status === "DELIVERED" && row.seconds !== null,
  );
  const sorted = delivered
    .map((row) => Math.max(0, Number(row.seconds)))
    .sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const undelivered = waits.length - delivered.length;
  const elapsedS = (Date.now() - startedAt) / 1000;
  const reasons: string[] = [];

  if (waits.length === 0) {
    reasons.push("nenhuma mensagem das outras empresas");
  }
  if (undelivered > 0) {
    reasons.push(`${undelivered} mensagem(ns) das outras empresas não saíram`);
  }
  if (p95 === null || p95 >= P95_LIMIT_S) {
    reasons.push(
      `p95 das outras empresas ${p95 === null ? "sem medida" : `${p95.toFixed(1)} s`} (limite ${P95_LIMIT_S} s)`,
    );
  }

  const summary = {
    run: RUN,
    fairClaim: env.QUEUE_FAIR_CLAIM_ENABLED === "true",
    providerMs: PROVIDER_MS,
    externalConcurrency: Number(env.NOTIFICATION_EXTERNAL_CONCURRENCY ?? 5),
    flood: {
      business: flooding,
      messages: floodCount,
      delivered: flood.delivered,
      failed: flood.failed,
      perSecond: Math.round((flood.delivered / elapsedS) * 10) / 10,
    },
    others: {
      companies: others.length,
      messages: waits.length,
      delivered: delivered.length,
      p50Seconds: percentile(sorted, 50),
      p95Seconds: p95,
      maxSeconds: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    },
    limitP95Seconds: P95_LIMIT_S,
    pass: reasons.length === 0,
    reasons,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`resumo em ${OUT}`);

  process.exit(summary.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
