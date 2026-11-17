import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  loadConcurrentFiles,
  runPrebuild,
  type PrebuildOutcome,
  type PrebuildPhase,
} from "infra/scripts/online-ddl";
import { openReleaseClient } from "infra/scripts/release-connection";

/**
 * prisma/concurrent against a real Postgres (plano-escala F2-01): the hot
 * tables' indexes built with CREATE INDEX CONCURRENTLY before `migrate
 * deploy`, while the app keeps writing.
 *
 * What matters on production's live tables: a writer never waits on the
 * build; the build behind a long transaction gives up its place after
 * lock_timeout and tries again instead of waiting in the lock queue; a CIC
 * that failed halfway leaves an INVALID index, which the next run drops and
 * builds again; a partitioned table gets the index ON ONLY plus one CIC and
 * one ATTACH per partition; the second run does nothing; a database without
 * the table (or without `_prisma_migrations`) skips, and a column the same
 * release adds gets its index from the pass after the migrations, the
 * migration building it only on an empty table. Scratch tables in the
 * file's own database: the step works by name, on any table.
 */
const URL = () => process.env.DATABASE_URL as string;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

let admin: pg.Client;
let dir: string;
const lines: string[] = [];

const log = {
  info: (message: string) => lines.push(`info ${message}`),
  warn: (message: string) => lines.push(`warn ${message}`),
};

function concurrentFile(name: string, sql: string) {
  writeFileSync(join(dir, name), sql);
}

async function prebuild(
  options: {
    lockTimeoutMs?: number;
    lockRetries?: number;
    searchPath?: string;
    phase?: PrebuildPhase;
    /** In place of the short pause between lock retries. */
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<PrebuildOutcome> {
  const { files, errors } = loadConcurrentFiles(dir);

  expect(errors).toEqual([]);

  const client = await openReleaseClient(URL(), "e2e-prebuild");

  try {
    if (options.searchPath) {
      await client.query(`SET search_path TO ${options.searchPath}`);
    }

    return await runPrebuild(client, files, {
      lockTimeoutMs: options.lockTimeoutMs ?? 3_000,
      lockRetries: options.lockRetries ?? 20,
      phase: options.phase,
      log,
      sleep: options.pause ?? ((ms) => sleep(Math.min(ms, 100))),
    });
  } finally {
    await client.end();
  }
}

async function indexValid(name: string): Promise<boolean | null> {
  const { rows } = await admin.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [name],
  );

  return rows[0]?.valid ?? null;
}

/** A writer inserting as fast as it can, timing each insert. */
function startWriter(table = "prebuild_probe") {
  let running = true;
  let slowest = 0;
  let writes = 0;
  let client: pg.Client | null = null;

  const done = (async () => {
    client = await openReleaseClient(URL(), "e2e-writer");

    while (running) {
      const startedAt = Date.now();

      await client.query(`INSERT INTO ${table} (v, note) VALUES (1, 'w')`);
      slowest = Math.max(slowest, Date.now() - startedAt);
      writes += 1;
      await sleep(5);
    }

    await client.end();
  })();

  return {
    async stop() {
      running = false;
      await done;

      return { slowest, writes };
    },
  };
}

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-prebuild-admin");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "trajetto-concurrent-e2e-"));
  lines.length = 0;

  await admin.query(`
    DROP TABLE IF EXISTS prebuild_probe;
    DROP TABLE IF EXISTS prebuild_parted;
    DROP TABLE IF EXISTS prebuild_empty;
    CREATE TABLE prebuild_probe (id bigserial PRIMARY KEY, v int, note text, dup int);
    INSERT INTO prebuild_probe (v, note) SELECT g % 100, 'seed' FROM generate_series(1, 5000) g;
    CREATE TABLE prebuild_parted (id bigserial, at date NOT NULL, v int) PARTITION BY RANGE (at);
    CREATE TABLE prebuild_parted_a PARTITION OF prebuild_parted FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
    CREATE TABLE prebuild_parted_b PARTITION OF prebuild_parted FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
    INSERT INTO prebuild_parted (at, v) SELECT DATE '2026-01-01' + (g % 59), g FROM generate_series(1, 2000) g;
  `);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the online DDL before the migrations", () => {
  it("builds the index while a writer keeps writing, and the second run does nothing", async () => {
    concurrentFile(
      "20261201000000_probe.sql",
      "-- requires-table: prebuild_probe\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_v_idx ON prebuild_probe (v, note);",
    );

    const writer = startWriter();

    await sleep(50);

    const first = await prebuild();
    const { slowest, writes } = await writer.stop();

    expect(first.files).toEqual([
      expect.objectContaining({
        file: "20261201000000_probe.sql",
        status: "applied",
      }),
    ]);
    expect(await indexValid("prebuild_probe_v_idx")).toBe(true);
    expect(writes).toBeGreaterThan(0);
    // The build never holds the writes: a plain CREATE INDEX would.
    expect(slowest).toBeLessThan(1_000);

    const second = await prebuild();

    expect(second.files).toEqual([
      expect.objectContaining({ status: "skipped", detail: "já estava feito" }),
    ]);
    expect(second.retries).toBe(0);
  });

  it("gives up after lock_timeout behind a long transaction, retries, and builds once it ends", async () => {
    concurrentFile(
      "20261201000000_probe.sql",
      "-- requires-table: prebuild_probe\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_note_idx ON prebuild_probe (note);",
    );

    // An open writing transaction: the CIC must wait for it to end.
    const blocker = await openReleaseClient(URL(), "e2e-blocker");

    await blocker.query("BEGIN");
    await blocker.query(
      "INSERT INTO prebuild_probe (v, note) VALUES (2, 'long')",
    );

    const writer = startWriter();
    const release = sleep(1_500).then(() => blocker.query("COMMIT"));
    const startedAt = Date.now();
    const outcome = await prebuild({ lockTimeoutMs: 200, lockRetries: 30 });
    const elapsed = Date.now() - startedAt;

    await release;
    await blocker.end();

    const { slowest } = await writer.stop();

    expect(outcome.retries).toBeGreaterThan(0);
    expect(await indexValid("prebuild_probe_note_idx")).toBe(true);
    // It waited for the transaction, not much past it.
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(10_000);
    // And no writer waited behind the build meanwhile.
    expect(slowest).toBeLessThan(1_000);
    expect(
      lines.some((line) => line.includes("o lock não veio em 200 ms")),
    ).toBe(true);
  });

  it("drops an index a failed CIC left invalid and builds it again", async () => {
    // A unique CIC over duplicates fails halfway and leaves the index
    // invalid: still maintained on every write, used by no plan.
    await admin.query("UPDATE prebuild_probe SET dup = 7 WHERE id IN (1, 2)");
    await expect(
      admin.query(
        "CREATE UNIQUE INDEX CONCURRENTLY prebuild_probe_dup_key ON prebuild_probe (dup)",
      ),
    ).rejects.toThrow();
    expect(await indexValid("prebuild_probe_dup_key")).toBe(false);

    await admin.query("UPDATE prebuild_probe SET dup = NULL WHERE id = 2");

    concurrentFile(
      "20261201000000_dup.sql",
      "-- requires-column: prebuild_probe.dup\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_dup_key ON prebuild_probe (dup);",
    );

    const outcome = await prebuild();

    expect(outcome.files[0].status).toBe("applied");
    expect(await indexValid("prebuild_probe_dup_key")).toBe(true);
    expect(lines.some((line) => line.includes("está inválido"))).toBe(true);
  });

  it("fails when an index it manages ends invalid, and only warns about the others", async () => {
    await admin.query("UPDATE prebuild_probe SET dup = 7 WHERE id IN (1, 2)");
    await expect(
      admin.query(
        "CREATE UNIQUE INDEX CONCURRENTLY prebuild_probe_stray_key ON prebuild_probe (dup)",
      ),
    ).rejects.toThrow();

    concurrentFile(
      "20261201000000_ok.sql",
      "-- requires-table: prebuild_probe\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_ok_idx ON prebuild_probe (v);",
    );

    const outcome = await prebuild();

    expect(outcome.strayInvalid).toContain("prebuild_probe_stray_key");
    expect(
      lines.some((line) => line.startsWith("warn índices inválidos")),
    ).toBe(true);

    concurrentFile(
      "20261201000100_dup.sql",
      "-- requires-column: prebuild_probe.dup\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_dup2_key ON prebuild_probe (dup);",
    );

    // Duplicates: a unique violation is not a lock wait, and is not retried.
    await expect(prebuild()).rejects.toThrow();
  });

  /**
   * The release failed, so the previous image keeps serving: a UNIQUE
   * index the failed CIC left behind (invalid, but ready) would go on
   * refusing the duplicates that image writes until someone dropped it.
   */
  it("drops the half-built UNIQUE index it gave up on, so the running version keeps writing", async () => {
    await admin.query("UPDATE prebuild_probe SET dup = 7 WHERE id IN (1, 2)");

    concurrentFile(
      "20261201000000_dup.sql",
      "-- requires-column: prebuild_probe.dup\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_dup3_key ON prebuild_probe (dup);",
    );

    await expect(prebuild()).rejects.toMatchObject({ code: "23505" });

    expect(await indexValid("prebuild_probe_dup3_key")).toBeNull();
    await expect(
      admin.query(
        "INSERT INTO prebuild_probe (v, note, dup) VALUES (1, 'old image', 7)",
      ),
    ).resolves.toBeDefined();
    expect(
      lines.some((line) =>
        line.includes("prebuild_probe_dup3_key, que a construção deixou"),
      ),
    ).toBe(true);
  });

  it("drops the index a CIC left behind when the lock retries ran out", async () => {
    concurrentFile(
      "20261201000000_probe.sql",
      "-- requires-table: prebuild_probe\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_id_v_key ON prebuild_probe (id, v);",
    );

    // An open writing transaction the CIC waits for, past every retry; it
    // ends only during the clean-up's own retries.
    const blocker = await openReleaseClient(URL(), "e2e-blocker");

    await blocker.query("BEGIN");
    await blocker.query(
      "INSERT INTO prebuild_probe (v, note) VALUES (2, 'long')",
    );

    let pauses = 0;

    try {
      await expect(
        prebuild({
          lockTimeoutMs: 200,
          lockRetries: 1,
          pause: async () => {
            pauses += 1;
            // 1: the CIC's retry; 2: the clean-up's first retry.
            if (pauses === 2) await blocker.query("COMMIT");
          },
        }),
      ).rejects.toThrow(/o lock não veio em 2 tentativas/);
    } finally {
      await blocker.end();
    }

    expect(pauses).toBe(2);
    expect(await indexValid("prebuild_probe_id_v_key")).toBeNull();
    expect(lines.some((line) => line.includes("foi removido"))).toBe(true);
  });

  it("drops a partitioned UNIQUE index whole when one partition fails, attached partitions included", async () => {
    // A duplicate in the second partition only: the first one builds and
    // attaches before the second fails.
    await admin.query(
      "INSERT INTO prebuild_parted (at, v) VALUES ('2026-02-10', 777777), ('2026-02-10', 777777)",
    );

    concurrentFile(
      "20261201000000_parted.sql",
      "-- requires-table: prebuild_parted\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS prebuild_parted_u_key ON prebuild_parted (at, v);",
    );

    await expect(prebuild()).rejects.toMatchObject({ code: "23505" });

    expect(await indexValid("prebuild_parted_u_key")).toBeNull();
    expect(
      await indexValid("prebuild_parted_a_prebuild_parted_u_key"),
    ).toBeNull();
    expect(
      await indexValid("prebuild_parted_b_prebuild_parted_u_key"),
    ).toBeNull();
    // The first partition takes a duplicate again, as before the release.
    await expect(
      admin.query(
        "INSERT INTO prebuild_parted (at, v) SELECT at, v FROM prebuild_parted_a LIMIT 1",
      ),
    ).resolves.toBeDefined();
  });

  it("builds a partitioned table's index ON ONLY, one CIC and one ATTACH per partition", async () => {
    concurrentFile(
      "20261201000000_parted.sql",
      "-- requires-table: prebuild_parted\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_parted_v_idx ON prebuild_parted (v);",
    );

    const outcome = await prebuild();

    expect(outcome.files[0].status).toBe("applied");
    expect(await indexValid("prebuild_parted_v_idx")).toBe(true);
    expect(await indexValid("prebuild_parted_a_prebuild_parted_v_idx")).toBe(
      true,
    );
    expect(await indexValid("prebuild_parted_b_prebuild_parted_v_idx")).toBe(
      true,
    );

    const { rows } = await admin.query<{ attached: number }>(`
      SELECT count(*)::int AS attached FROM pg_inherits
       WHERE inhparent = 'prebuild_parted_v_idx'::regclass`);

    expect(rows[0].attached).toBe(2);

    // A partition the job attaches later gets its index from Postgres.
    await admin.query(
      "CREATE TABLE prebuild_parted_c PARTITION OF prebuild_parted FOR VALUES FROM ('2026-03-01') TO ('2026-04-01')",
    );

    const second = await prebuild();

    expect(second.files[0].status).toBe("skipped");
    expect(await indexValid("prebuild_parted_v_idx")).toBe(true);
  });

  it("skips a file whose table or column does not exist yet: the migration builds it", async () => {
    concurrentFile(
      "20261201000000_later.sql",
      "-- requires-column: prebuild_probe.not_yet\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_later_idx ON prebuild_probe (not_yet);",
    );
    concurrentFile(
      "20261201000100_absent.sql",
      "-- requires-table: prebuild_absent\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_absent_idx ON prebuild_absent (id);",
    );

    const outcome = await prebuild();

    expect(outcome.files.map((file) => file.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(await indexValid("prebuild_probe_later_idx")).toBeNull();
  });

  /**
   * A column and its index in the same release (the whole scale plan ships
   * in one push): before the migrations the column is not there, the
   * migration builds the index only on an empty table, and the pass after
   * the migrations builds it on the live one, concurrently.
   */
  it("builds after the migrations the index of a column the same release adds", async () => {
    concurrentFile(
      "20261201000000_fresh.sql",
      "-- requires-column: prebuild_probe.fresh\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_fresh_idx ON prebuild_probe (fresh);",
    );

    const before = await prebuild();

    expect(before.files).toEqual([
      expect.objectContaining({
        status: "skipped",
        detail: expect.stringContaining("o passo depois das migrations"),
      }),
    ]);

    // The migration's form (migration-prebuild.test.ts): the column, and
    // the index only when the table is empty.
    const migration = (table: string) =>
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS fresh int;
       DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM "${table}" LIMIT 1) THEN
           CREATE INDEX IF NOT EXISTS ${table}_fresh_idx ON ${table} (fresh);
         END IF;
       END $$;`;

    await admin.query(migration("prebuild_probe"));
    expect(await indexValid("prebuild_probe_fresh_idx")).toBeNull();

    // On a new database the same migration builds it, the table empty.
    await admin.query("CREATE TABLE prebuild_empty (id int)");
    await admin.query(migration("prebuild_empty"));
    expect(await indexValid("prebuild_empty_fresh_idx")).toBe(true);

    const writer = startWriter();

    await sleep(50);

    const after = await prebuild({ phase: "after" });
    const { slowest, writes } = await writer.stop();

    expect(after.files).toEqual([
      expect.objectContaining({ status: "applied" }),
    ]);
    expect(await indexValid("prebuild_probe_fresh_idx")).toBe(true);
    expect(writes).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(1_000);
  });

  it("warns, after the migrations, about a file whose column no migration created", async () => {
    concurrentFile(
      "20261201000000_stale.sql",
      "-- requires-column: prebuild_probe.gone\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_gone_idx ON prebuild_probe (gone);",
    );

    const outcome = await prebuild({ phase: "after" });

    expect(outcome.files[0].status).toBe("skipped");
    expect(
      lines.some(
        (line) =>
          line.startsWith("warn ") &&
          line.includes("mesmo depois das migrations"),
      ),
    ).toBe(true);
  });

  it("skips the whole step on a new database, before any migration", async () => {
    await admin.query(
      "DROP SCHEMA IF EXISTS prebuild_new CASCADE; CREATE SCHEMA prebuild_new",
    );

    concurrentFile(
      "20261201000000_probe.sql",
      "-- requires-table: prebuild_probe\nCREATE INDEX CONCURRENTLY IF NOT EXISTS prebuild_probe_new_idx ON prebuild_probe (v);",
    );

    const outcome = await prebuild({ searchPath: "prebuild_new" });

    expect(outcome.newDatabase).toBe(true);
    expect(outcome.files).toEqual([]);
    expect(await indexValid("prebuild_probe_new_idx")).toBeNull();
  });

  it("drops an index concurrently, and a second drop is a no-op", async () => {
    await admin.query(
      "CREATE INDEX prebuild_probe_old_idx ON prebuild_probe (v)",
    );

    concurrentFile(
      "20261201000000_drop.sql",
      "DROP INDEX CONCURRENTLY IF EXISTS prebuild_probe_old_idx;",
    );

    expect((await prebuild()).files[0].status).toBe("applied");
    expect(await indexValid("prebuild_probe_old_idx")).toBeNull();
    expect((await prebuild()).files[0].status).toBe("skipped");
  });

  /**
   * The planner settings (F2-22): a column's statistics target, the
   * autovacuum scale factors and an extended statistics object. Each takes
   * SHARE UPDATE EXCLUSIVE, the lock every autovacuum and ANALYZE holds, and
   * the step runs every file on every release: repeating them would queue
   * each release behind whatever vacuum is running on the hot tables (an
   * anti-wraparound one does not yield), and fail it when the retries ran
   * out. Once in effect they are read from the catalog and not run again.
   */
  it("sets statistics and storage parameters, and a second run takes no lock at all", async () => {
    concurrentFile(
      "20261201000000_stats.sql",
      [
        "-- requires-table: prebuild_probe",
        'ALTER TABLE prebuild_probe ALTER COLUMN "v" SET STATISTICS 1000;',
        "ALTER TABLE prebuild_probe SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);",
        "CREATE STATISTICS IF NOT EXISTS prebuild_probe_v_note_stats (mcv, dependencies) ON v, note FROM prebuild_probe;",
      ].join("\n"),
    );

    expect((await prebuild()).files[0].status).toBe("applied");

    const { rows } = await admin.query<{
      target: number | null;
      options: string[] | null;
      stats: string[];
    }>(
      `SELECT
         (SELECT attstattarget::int FROM pg_attribute
           WHERE attrelid = 'prebuild_probe'::regclass AND attname = 'v') AS target,
         (SELECT reloptions FROM pg_class WHERE oid = 'prebuild_probe'::regclass) AS options,
         ARRAY(SELECT stxname::text FROM pg_statistic_ext
                WHERE stxrelid = 'prebuild_probe'::regclass) AS stats`,
    );

    expect(rows[0]).toEqual({
      target: 1000,
      options: [
        "autovacuum_vacuum_scale_factor=0.02",
        "autovacuum_analyze_scale_factor=0.01",
      ],
      stats: ["prebuild_probe_v_note_stats"],
    });

    // A vacuum's lock, held for the whole second run.
    const vacuum = await openReleaseClient(URL(), "e2e-vacuum");

    await vacuum.query("BEGIN");
    await vacuum.query(
      "LOCK TABLE prebuild_probe IN SHARE UPDATE EXCLUSIVE MODE",
    );

    try {
      const second = await prebuild({ lockTimeoutMs: 200, lockRetries: 1 });

      expect(second.files).toEqual([
        expect.objectContaining({
          status: "skipped",
          detail: "já estava feito",
        }),
      ]);
      expect(second.retries).toBe(0);
    } finally {
      await vacuum.query("ROLLBACK");
      await vacuum.end();
    }

    // A different value is not "in effect": it runs again.
    concurrentFile(
      "20261201000000_stats.sql",
      [
        "-- requires-table: prebuild_probe",
        'ALTER TABLE prebuild_probe ALTER COLUMN "v" SET STATISTICS 500;',
      ].join("\n"),
    );

    expect((await prebuild()).files[0].status).toBe("applied");
  });
});
