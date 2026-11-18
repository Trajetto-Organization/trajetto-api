import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import { maintainPartitions } from "@/jobs/cron/partition-maintenance-job";
import { PARTITION_OWNER_ROLE } from "@/shared/database/partition-owner";
import {
  addGrains,
  grainStart,
  partitionName,
  registeredPartitions,
  retentionCutoff,
} from "@/shared/database/partitions";

/**
 * The nightly partition-maintenance job against a real Postgres
 * (plano-escala F2-08), on driver_position, the registry's first table.
 *
 * What it must keep true, and why each one matters:
 *  - the partitions ahead exist, made by LIKE + ATTACH as the owner role,
 *    with the parent's indexes (the unique (driverId, recorded_at) the
 *    writer's ON CONFLICT relies on);
 *  - a day past the retention is detached CONCURRENTLY and dropped, and
 *    the day after it stays;
 *  - a DETACH a previous night left half-way ("pending") is FINALIZEd and
 *    dropped, and a table detached but not dropped is dropped: neither may
 *    stay on the disk forever;
 *  - on Sundays the parent is analyzed and the settled days frozen, and
 *    nothing that still changes.
 *
 * The lock behaviour (the pings never wait, a busy parent is retried and
 * then left for the next night) is in driver-position-partition-locks.
 */
const URL = () => process.env.DATABASE_URL as string;
const DAY_MS = 24 * 60 * 60 * 1000;
const [trail] = registeredPartitions();

let admin: pg.Client;

async function attached(): Promise<Map<string, boolean>> {
  const { rows } = await admin.query<{ relname: string; pending: boolean }>(
    `SELECT c.relname::text AS relname, i.inhdetachpending AS pending
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'driver_position'::regclass`,
  );

  return new Map(rows.map((row) => [row.relname, row.pending]));
}

async function exists(name: string): Promise<boolean> {
  const { rows } = await admin.query<{ present: boolean }>(
    "SELECT to_regclass(quote_ident($1)) IS NOT NULL AS present",
    [name],
  );

  return rows[0].present;
}

async function ownerOf(name: string): Promise<string> {
  const { rows } = await admin.query<{ owner: string }>(
    "SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid = to_regclass(quote_ident($1))",
    [name],
  );

  return rows[0].owner;
}

/** A partition of `day` made by hand, as a superuser in an incident would. */
async function partitionByHand(day: Date): Promise<string> {
  const name = partitionName(trail, day);
  const next = addGrains("day", day, 1);

  await admin.query(
    `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "driver_position"
       FOR VALUES FROM ('${day.toISOString()}') TO ('${next.toISOString()}')`,
  );

  return name;
}

async function insertPing(at: Date): Promise<void> {
  await admin.query(
    `INSERT INTO driver_position (id, "driverId", "businessId", latitude, longitude, recorded_at)
     VALUES ($1, $2, $3, -23.5, -46.6, $4)`,
    [randomUUID(), randomUUID(), randomUUID(), at.toISOString()],
  );
}

const today = () => grainStart("day", new Date());

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-partition-maintenance");

  // The template may be a few days old: today's run first, so each test
  // starts from the state a night leaves.
  await maintainPartitions();
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe("partition-maintenance on driver_position", () => {
  it("creates the lookahead by LIKE and ATTACH, as the owner role, with the parent's indexes", async () => {
    const farthest = partitionName(
      trail,
      addGrains("day", today(), trail.lookahead),
    );
    const before = addGrains("day", today(), trail.lookahead - 1);

    await admin.query(`DROP TABLE IF EXISTS "${farthest}"`);
    await admin.query(`DROP TABLE IF EXISTS "${partitionName(trail, before)}"`);

    const outcome = await maintainPartitions();

    expect(outcome.driver_position).toMatchObject({
      created: 2,
      postponed: 0,
      ownerOk: true,
      missingNow: [],
    });

    const now = await attached();

    for (let offset = -1; offset <= trail.lookahead; offset += 1) {
      const name = partitionName(trail, addGrains("day", today(), offset));

      expect(now.get(name), name).toBe(false);
    }

    expect(await ownerOf(farthest)).toBe(PARTITION_OWNER_ROLE);

    // ATTACH built the parent's indexes on the new partition: the unique
    // (driverId, recorded_at) the writer's ON CONFLICT relies on included.
    const { rows } = await admin.query<{ parent: number; child: number }>(
      `SELECT
         (SELECT count(*) FROM pg_index WHERE indrelid = 'driver_position'::regclass)::int AS parent,
         (SELECT count(*) FROM pg_index WHERE indrelid = to_regclass(quote_ident($1)))::int AS child`,
      [farthest],
    );

    expect(rows[0].child).toBe(rows[0].parent);

    // And a second run has nothing to do.
    const again = await maintainPartitions();

    expect(again.driver_position).toMatchObject({ created: 0, dropped: 0 });
  });

  it("detaches and drops the day past the retention, and keeps the day after it", async () => {
    const cutoff = retentionCutoff(trail);
    const expiredDay = new Date(cutoff.getTime() - DAY_MS);

    // Made by the job itself, as the role: the nights it was the one that
    // created them.
    await maintainPartitions({ now: new Date(cutoff.getTime() + 60_000) });

    const expired = partitionName(trail, expiredDay);
    const kept = partitionName(trail, cutoff);

    expect(await ownerOf(expired)).toBe(PARTITION_OWNER_ROLE);
    expect((await attached()).has(kept)).toBe(true);

    const outcome = await maintainPartitions();

    expect(outcome.driver_position.dropped).toBeGreaterThanOrEqual(1);
    expect(outcome.driver_position.ownerOk).toBe(true);
    expect(await exists(expired)).toBe(false);
    expect((await attached()).has(kept)).toBe(true);
  });

  it("finalizes a DETACH a previous night left pending, then drops it", async () => {
    const pendingDay = new Date(retentionCutoff(trail).getTime() - 3 * DAY_MS);
    const name = await partitionByHand(pendingDay);

    // A reader with the parent open, as a long report or a pg_dump: the
    // DETACH … CONCURRENTLY marks the partition and then waits for it, and
    // is cut short there, as a deploy or a timeout would cut it.
    const reader = await openReleaseClient(URL(), "e2e-partition-reader");
    const detacher = await openReleaseClient(URL(), "e2e-partition-detacher");

    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await reader.query("SELECT count(*) FROM driver_position");

      await detacher.query("SET statement_timeout = '1500ms'");
      await expect(
        detacher.query(
          `ALTER TABLE driver_position DETACH PARTITION "${name}" CONCURRENTLY`,
        ),
      ).rejects.toThrow();
    } finally {
      await reader.query("ROLLBACK").catch(() => undefined);
      await reader.end();
      await detacher.end();
    }

    expect((await attached()).get(name)).toBe(true);

    const outcome = await maintainPartitions();

    expect(outcome.driver_position.finalized).toBe(1);
    expect(await exists(name)).toBe(false);
    expect([...(await attached()).values()]).not.toContain(true);
  });

  it("drops a day a previous night detached and did not drop, and nothing it should keep", async () => {
    const leftover = partitionName(
      trail,
      new Date(retentionCutoff(trail).getTime() - 7 * DAY_MS),
    );
    // Named like a partition, detached, but still inside the retention.
    const recent = partitionName(trail, addGrains("day", today(), -30));
    // A table the registry does not know, whose name starts the same:
    // driver_position_v9 is not driver_position.
    const otherTable = "driver_position_v9_20000101";
    // The lean trail's own leftover (plano-escala F2-10): its entry drops
    // it, and the legacy entry does not count it.
    const leanLeftover = "driver_position_v2_20000101";

    for (const name of [leftover, recent, otherTable]) {
      await admin.query(`CREATE TABLE "${name}" (LIKE driver_position)`);
    }

    await admin.query(
      `CREATE TABLE "${leanLeftover}" (LIKE driver_position_v2)`,
    );

    try {
      const outcome = await maintainPartitions();

      expect(outcome.driver_position.dropped).toBeGreaterThanOrEqual(1);
      expect(await exists(leftover)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(otherTable)).toBe(true);
      expect(outcome.driver_position_v2.dropped).toBeGreaterThanOrEqual(1);
      expect(await exists(leanLeftover)).toBe(false);
    } finally {
      await admin.query(
        `DROP TABLE IF EXISTS "${recent}", "${otherTable}", "${leanLeftover}"`,
      );
    }
  });

  it("on Sundays, analyzes the parent and freezes the days that settled, and only those", async () => {
    // The last Sunday, at the job's hour.
    const sunday = new Date(
      today().getTime() - today().getUTCDay() * DAY_MS + (4 * 60 + 10) * 60_000,
    );
    const sundayStart = grainStart("day", sunday);

    // Days 11 to 3 before that Sunday, made by the job as on those nights.
    await maintainPartitions({
      now: new Date(sundayStart.getTime() - 10 * DAY_MS),
    });

    const settled = addGrains("day", sundayStart, -10);
    const fresh = addGrains("day", sundayStart, -4);

    await insertPing(new Date(settled.getTime() + 3_600_000));
    await insertPing(new Date(fresh.getTime() + 3_600_000));

    const outcome = await maintainPartitions({ now: sunday });

    expect(outcome.driver_position.analyzed).toBe(true);
    expect(outcome.driver_position.frozen).toBeGreaterThanOrEqual(1);

    const vacuumed = async (day: Date) => {
      const { rows } = await admin.query<{ last_vacuum: Date | null }>(
        "SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = $1",
        [partitionName(trail, day)],
      );

      return rows[0]?.last_vacuum ?? null;
    };

    expect(await vacuumed(settled)).not.toBeNull();
    // Four days ago still takes the app's offline pings: not frozen yet.
    expect(await vacuumed(fresh)).toBeNull();

    // The parent's own statistics, which autovacuum never gathers.
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stats WHERE tablename = 'driver_position' AND inherited",
    );

    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("postpones the removal when the DDL connection cannot open, and still keeps every table ahead", async () => {
    // A connection refused before it opens (a URL through PgBouncer, which
    // ddl-connection.ts refuses) or a Database away at 04:10: what it would
    // have detached waits for the next night. It must not cost tomorrow's
    // partitions of the tables after it, or the pings of the day after
    // would be refused with no partition to land in.
    const tables = registeredPartitions();
    const lean = tables.find((table) => table.table !== trail.table);

    if (!lean) throw new Error("o registro tem uma tabela só");

    const cutoff = retentionCutoff(trail);
    const expired = partitionName(trail, new Date(cutoff.getTime() - DAY_MS));
    const farthest = partitionName(
      lean,
      addGrains("day", today(), lean.lookahead),
    );

    await maintainPartitions({ now: new Date(cutoff.getTime() + 60_000) });
    await admin.query(`DROP TABLE IF EXISTS "${farthest}"`);

    let opened = 0;
    const outcome = await maintainPartitions({
      tables,
      openDdl: async () => {
        opened += 1;
        throw new Error("a conexão de DDL não abriu");
      },
    });

    expect(outcome[trail.table]).toMatchObject({ dropped: 0, missingNow: [] });
    expect(outcome[trail.table].postponed).toBeGreaterThanOrEqual(1);
    expect(await exists(expired)).toBe(true);
    expect(outcome[lean.table].created).toBeGreaterThanOrEqual(1);
    expect(await exists(farthest)).toBe(true);
    // One attempt for the whole run, not one per step.
    expect(opened).toBe(1);

    // The next night, with the connection back, does what waited.
    await maintainPartitions();

    expect(await exists(expired)).toBe(false);
  });
});

/**
 * The queues in the registry (plano-escala F5-07): plain tables until the
 * swap of F5-09, which the job leaves alone; once partitioned, each new
 * day gets the storage parameters the plain table had, which a
 * partitioned parent cannot carry and LIKE does not copy.
 */
describe("the queues", () => {
  it("are left alone while they are plain tables", async () => {
    const queues = registeredPartitions().filter(
      (table) => table.plainUntilSwap,
    );

    expect(queues.map((table) => table.table)).toContain("domain_outbox_event");

    const outcome = await maintainPartitions({ tables: queues });

    for (const table of queues) {
      expect(outcome[table.table], table.table).toMatchObject({
        created: 0,
        missingNow: [],
      });
      expect(await exists(partitionName(table, today())), table.table).toBe(
        false,
      );
    }
  });

  it("give a partitioned queue's new days their storage parameters", async () => {
    await admin.query(
      `CREATE TABLE "queue_probe" ("id" text NOT NULL, PRIMARY KEY ("id")) PARTITION BY RANGE ("id")`,
    );

    const probe = {
      table: "queue_probe",
      grain: "day",
      key: "uuid7",
      lookahead: 2,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: null,
      settleDays: 3,
      plainUntilSwap: true,
      reloptions: ["fillfactor=70", "autovacuum_vacuum_cost_delay=2"],
    } as const;

    const outcome = await maintainPartitions({ tables: [probe] });

    expect(outcome.queue_probe).toMatchObject({ created: 4, missingNow: [] });

    const { rows } = await admin.query<{ relname: string; options: string[] }>(
      `SELECT c.relname::text AS relname, c.reloptions AS options
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'queue_probe'::regclass
        ORDER BY 1`,
    );

    expect(rows).toHaveLength(4);

    for (const row of rows) {
      expect([...row.options].sort(), row.relname).toEqual([
        "autovacuum_vacuum_cost_delay=2",
        "fillfactor=70",
      ]);
    }
  });
});
