import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { deliveriesInWindowSql } from "@/shared/health/metrics-queries";

/**
 * The "created in the last 24 h" counters of /health/metrics read the window,
 * not the table — on a table that has lived (OBS-09, PG-18).
 *
 * They were served by a BRIN on created_at, and the plan test passed: on a
 * freshly loaded table the BRIN is used and narrow. notification_delivery is
 * not a freshly loaded table. Every row is claimed and settled (two non-HOT
 * updates) and purged after 30 days, and new versions go wherever the free
 * space map finds room — holes in pages written weeks ago. A BRIN range only
 * ever widens: one recent row in a page of a 128-page range makes the whole
 * range match "created_at >= yesterday". Simulated with daily churn and a
 * short retention, the BRIN matched every page of the table for a one-day
 * window; the "index-served" count was a full read of the widest table of the
 * pipeline, on every opening of the MASTER's screen.
 *
 * This builds that state on purpose — old rows in summarized ranges, then
 * recent rows written into space freed at the start of each range — and
 * requires the window count to touch a fraction of the table, not all of it.
 */
const prisma = new PrismaClient();

const USER = "018fda90-0000-7000-8000-0000000000u1";

/** Events seeded as "old", five deliveries each: ~9 BRIN ranges of pages. */
const OLD_EVENTS = 1_600;

/** SQL for a uuid v7 minted at the timestamp expression `ts`. */
const uuid7At = (ts: string, salt: string) => `(
  substr(lpad(to_hex((extract(epoch from ${ts}) * 1000)::bigint), 12, '0'), 1, 8) || '-' ||
  substr(lpad(to_hex((extract(epoch from ${ts}) * 1000)::bigint), 12, '0'), 9, 4) || '-7' ||
  substr(md5(random()::text || ${salt}), 1, 3) || '-8' ||
  substr(md5(random()::text || ${salt}), 4, 3) || '-' ||
  substr(md5(random()::text || ${salt}), 7, 12)
)`;

interface PlanNode {
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
}

let recentRows = 0;

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: USER,
      name: "Destinatária da Janela",
      email: `window-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  // Weeks of settled traffic, in creation order: the BRIN starts out narrow.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "domain_outbox_event"
      ("id", "eventKey", "topic", "aggregateType", "aggregateId", "payload",
       "status", "availableAt", "processedAt", "created_at", "updated_at")
    SELECT
      gen_random_uuid()::text, 'window-old-' || g, 'metrics.window', 'window', g::text, '{}'::jsonb,
      'PUBLISHED', ts, ts, ts, ts
    FROM (
      SELECT g, now() - interval '20 days' + g * interval '15 minutes' AS ts
      FROM generate_series(1, ${OLD_EVENTS}) AS g
    ) s
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_delivery"
      ("id", "outboxEventId", "userId", "channel", "status", "attempts",
       "lastError", "availableAt", "created_at", "updated_at")
    SELECT
      ${uuid7At('e."created_at"', 'e."id" || c.channel')},
      e."id", '${USER}', c.channel::"NotificationChannel", 'DELIVERED', 1,
      repeat('x', 600), e."created_at", e."created_at", e."created_at"
    FROM "domain_outbox_event" e
    CROSS JOIN (VALUES ('IN_APP'), ('EMAIL'), ('WHATSAPP'), ('ACTIVITY'), ('PUSH')) AS c(channel)
    WHERE e."topic" = 'metrics.window'
    ORDER BY e."created_at"
  `);

  // Summarizes every full range and records the table's free space.
  await prisma.$executeRawUnsafe(`VACUUM ANALYZE "notification_delivery"`);

  // The purge and the pruning of dead versions free space inside old pages:
  // here, the first page of each 128-page range.
  const freed = await prisma.$executeRawUnsafe(`
    DELETE FROM "notification_delivery"
    WHERE ((ctid::text::point)[0])::bigint % 128 = 0
  `);

  // INDEX_CLEANUP ON: with this few dead rows VACUUM would otherwise skip its
  // second pass and never tell the free space map about the freed pages.
  await prisma.$executeRawUnsafe(
    `VACUUM (INDEX_CLEANUP ON) "notification_delivery"`,
  );

  // Today's deliveries land in that space, as the free space map directs.
  const recentEvents = Math.ceil((freed * 2) / 5);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "domain_outbox_event"
      ("id", "eventKey", "topic", "aggregateType", "aggregateId", "payload",
       "status", "availableAt", "processedAt", "created_at", "updated_at")
    SELECT
      gen_random_uuid()::text, 'window-new-' || g, 'metrics.window.new', 'window', g::text, '{}'::jsonb,
      'PUBLISHED', ts, ts, ts, ts
    FROM (
      SELECT g, now() - interval '5 minutes' + g * interval '1 second' AS ts
      FROM generate_series(1, ${recentEvents}) AS g
    ) s
  `);

  recentRows = await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_delivery"
      ("id", "outboxEventId", "userId", "channel", "status", "attempts",
       "lastError", "availableAt", "created_at", "updated_at")
    SELECT
      ${uuid7At('e."created_at"', 'e."id" || c.channel')},
      e."id", '${USER}', c.channel::"NotificationChannel", 'DELIVERED', 1,
      repeat('x', 600), e."created_at", e."created_at", e."created_at"
    FROM "domain_outbox_event" e
    CROSS JOIN (VALUES ('IN_APP'), ('EMAIL'), ('WHATSAPP'), ('ACTIVITY'), ('PUSH')) AS c(channel)
    WHERE e."topic" = 'metrics.window.new'
  `);

  await prisma.$executeRawUnsafe(`ANALYZE "notification_delivery"`);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function tablePages(): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ pages: number }>>(
    `SELECT (pg_relation_size('"notification_delivery"') / 8192)::int AS pages`,
  );

  return row.pages;
}

describe("the 24 h window on a table that has lived", () => {
  it("is set up: recent rows sit inside several old, summarized ranges", async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ ranges: number }>>(`
      SELECT count(DISTINCT ((ctid::text::point)[0])::bigint / 128)::int AS ranges
      FROM "notification_delivery"
      WHERE "created_at" >= now() - interval '1 day'
        AND ((ctid::text::point)[0])::bigint < 128 * 5
    `);

    expect(await tablePages()).toBeGreaterThanOrEqual(640);
    expect(row.ranges).toBeGreaterThanOrEqual(3);
  });

  it("counts exactly the deliveries created in the window", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw<Array<{ n: number }>>(
      deliveriesInWindowSql(since),
    );

    expect(rows.reduce((total, row) => total + row.n, 0)).toBe(recentRows);
  });

  it("reads a fraction of the table, not every page of it", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const query = deliveriesInWindowSql(since);

    const [row] = await prisma.$queryRawUnsafe<
      Array<{ "QUERY PLAN": unknown }>
    >(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, ...query.values);

    const plan = (row["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;
    const buffers =
      (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);

    const pages = await tablePages();

    expect(buffers, JSON.stringify(row["QUERY PLAN"])).toBeLessThan(pages / 2);
  });
});
