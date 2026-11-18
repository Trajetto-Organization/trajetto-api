import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseBatch } from "infra/database";
import { openReleaseClient } from "infra/scripts/release-connection";
import {
  maintainPartitions,
  partitionArchiveJobs,
} from "@/jobs/cron/partition-maintenance-job";
import { InMemoryArchiveStorage } from "@/shared/archive/in-memory-archive-storage";
import {
  createTrailArchiveGate,
  deleteTrailArchive,
  type ArchiveDatabase,
  type TrailArchiveJobs,
} from "@/shared/archive/trail-archive";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobRunner } from "@/shared/jobs/job-runner";
import { createPartitionArchiveJob } from "@/shared/jobs/partition-archive";
import {
  addGrains,
  partitionName,
  registeredPartitions,
  retentionCutoff,
  type PartitionedTable,
} from "@/shared/database/partitions";

/**
 * The trail's archive in the nightly partition job, against a real Postgres
 * and a fake bucket (plano-escala F2-11).
 *
 * What must hold, and why:
 *  - a day past the retention becomes one object per company, a gzipped
 *    CSV with every row, written down in archive_manifest with its count
 *    and the sha256 of its bytes, and only then is it dropped: a dropped
 *    day is gone, and the archive is the copy decision D3 keeps 180 days;
 *  - the rows of a company that no longer exists are counted and left out
 *    (its exit took everything else of it);
 *  - a crash half-way (an upload cut, or a manifest write lost after the
 *    upload) keeps the day, and the rerun rewrites the same key: one
 *    object per company, never two;
 *  - a day whose manifest does not add up, a run out of budget and an
 *    archive switched on without its bucket all KEEP the day;
 *  - the legacy trail's days are archived too, under legacy/;
 *  - a day detached on an earlier night is dropped only with its archive
 *    verified;
 *  - deleteTrailArchive and the night's housekeeping remove a company's
 *    objects with its manifest rows, and the manifest is purged after the
 *    bucket expired its objects.
 */
const URL = () => process.env.DATABASE_URL as string;
const DAY_MS = 24 * 60 * 60 * 1000;

const entry = (name: string) => {
  const found = registeredPartitions().find((table) => table.table === name);

  if (!found) throw new Error(`${name} não está no registro`);

  return found;
};

const lean = entry("driver_position_v2");
const legacy = entry("driver_position");

let admin: pg.Client;

/** A day past the retention, `back` days before the cutoff. */
const expiredDay = (back: number) =>
  new Date(retentionCutoff(lean).getTime() - back * DAY_MS);

async function attachDay(table: PartitionedTable, day: Date): Promise<string> {
  const name = partitionName(table, day);
  const next = addGrains("day", day, 1);

  await admin.query(
    `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table.table}"
       FOR VALUES FROM ('${day.toISOString()}') TO ('${next.toISOString()}')`,
  );

  return name;
}

async function exists(name: string): Promise<boolean> {
  const { rows } = await admin.query<{ present: boolean }>(
    "SELECT to_regclass(quote_ident($1)) IS NOT NULL AS present",
    [name],
  );

  return rows[0].present;
}

async function company(): Promise<string> {
  const id = randomUUID();

  await admin.query(
    `INSERT INTO business (id, corporate_reason, cep, city, uf, street,
       address_number, cnpj, cnae, responsible_name, telephone, email, updated_at)
     VALUES ($1, $2, '01001000', 'São Paulo', 'SP', 'Rua', '1', $3, '4930202',
       'Responsável', '11999999999', $4, now())`,
    [
      id,
      `Arquivo ${id}`,
      String(Math.floor(Math.random() * 1e14)).padStart(14, "0"),
      `arquivo-${id}@example.com`,
    ],
  );

  return id;
}

/** `count` points of a driver on `day`, a minute apart from 10:00 UTC. */
async function points(
  table: "driver_position_v2" | "driver_position",
  businessId: string,
  driverId: string,
  day: Date,
  count: number,
): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const at = new Date(day.getTime() + 10 * 3_600_000 + n * 60_000);

    if (table === "driver_position_v2") {
      await admin.query(
        `INSERT INTO driver_position_v2
           ("driverId", "businessId", latitude, longitude, accuracy, battery, recorded_at)
         VALUES ($1, $2, -23.5 - $3::float8 / 1000, -46.6, 5, 80, $4)`,
        [driverId, businessId, n, at.toISOString()],
      );
    } else {
      await admin.query(
        `INSERT INTO driver_position
           (id, "driverId", "businessId", latitude, longitude, recorded_at)
         VALUES ($1, $2, $3, -23.5, -46.6, $4)`,
        [randomUUID(), driverId, businessId, at.toISOString()],
      );
    }
  }
}

interface ManifestRow {
  businessId: string;
  status: string;
  row_count: number | null;
  byte_size: string | null;
  sha256: string | null;
  object_key: string;
}

async function manifestOf(partition: string): Promise<ManifestRow[]> {
  const { rows } = await admin.query<ManifestRow>(
    `SELECT "businessId", status::text AS status, row_count,
            byte_size::text AS byte_size, sha256, object_key
       FROM archive_manifest WHERE partition_name = $1
      ORDER BY "businessId"`,
    [partition],
  );

  return rows;
}

const gateWith = (
  storage: InMemoryArchiveStorage | null,
  overrides: {
    deadline?: number;
    db?: ArchiveDatabase;
    jobs?: TrailArchiveJobs;
  } = {},
) =>
  createTrailArchiveGate({
    db: overrides.db ?? databaseBatch,
    storage,
    jobs: overrides.jobs,
    missing: storage ? [] : ["TRAIL_ARCHIVE_BUCKET"],
    deadline: overrides.deadline ?? Date.now() + 60_000,
    retentionDays: 180,
    // Two rows a page: every driver of these tests spans pages.
    pageSize: 2,
  });

const dayKey = (day: Date) => day.toISOString().slice(0, 10).replace(/-/g, "");

const csvOf = (storage: InMemoryArchiveStorage, key: string) =>
  gunzipSync(storage.objects.get(key) as Buffer)
    .toString("utf8")
    .trimEnd()
    .split("\n");

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-trail-archive");
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe("the trail archive in partition-maintenance", () => {
  it("archives each company's day to one object, checks the sum and only then drops the day", async () => {
    const day = expiredDay(2);
    const name = await attachDay(lean, day);
    const [first, second] = [await company(), await company()];
    const gone = randomUUID();
    const [driverA, driverB, driverC, driverG] = [1, 2, 3, 4].map(() =>
      randomUUID(),
    );

    await points("driver_position_v2", first, driverA, day, 3);
    await points("driver_position_v2", first, driverB, day, 2);
    await points("driver_position_v2", second, driverC, day, 4);
    // A company deleted since: its rows are counted, not archived.
    await points("driver_position_v2", gone, driverG, day, 2);

    const storage = new InMemoryArchiveStorage();
    const outcome = await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(outcome.driver_position_v2.archived).toBeGreaterThanOrEqual(1);
    expect(await exists(name)).toBe(false);

    const firstKey = `trail/${dayKey(day)}/${first}.csv.gz`;
    const secondKey = `trail/${dayKey(day)}/${second}.csv.gz`;

    expect(
      [...storage.objects.keys()]
        .filter((key) => key.includes(dayKey(day)))
        .sort(),
    ).toEqual([firstKey, secondKey].sort());

    const lines = csvOf(storage, firstKey);

    expect(lines[0]).toBe(
      "driver_id,recorded_at,route_id,latitude,longitude,accuracy,speed,heading,battery",
    );
    expect(lines).toHaveLength(1 + 5);

    // Driver by driver, each in time order, across the pages of two.
    const rows = lines.slice(1).map((line) => line.split(","));
    const drivers = rows.map((row) => row[0]);

    expect(drivers).toEqual(
      driverA < driverB
        ? [driverA, driverA, driverA, driverB, driverB]
        : [driverB, driverB, driverA, driverA, driverA],
    );

    for (const driver of [driverA, driverB]) {
      const times = rows
        .filter((row) => row[0] === driver)
        .map((row) => row[1]);

      expect(times).toEqual([...times].sort());
    }

    const ofA = lines.slice(1).filter((line) => line.startsWith(driverA));

    expect(ofA).toHaveLength(3);
    expect(ofA[0]).toBe(
      `${driverA},${new Date(day.getTime() + 10 * 3_600_000).toISOString()},,-23.5,-46.6,5,,,80`,
    );

    const manifest = await manifestOf(name);
    const byCompany = new Map(manifest.map((row) => [row.businessId, row]));
    const firstBytes = storage.objects.get(firstKey) as Buffer;

    expect(byCompany.get(first)).toMatchObject({
      status: "ARCHIVED",
      row_count: 5,
      object_key: firstKey,
      byte_size: String(firstBytes.length),
      sha256: createHash("sha256").update(firstBytes).digest("hex"),
    });
    expect(byCompany.get(second)).toMatchObject({
      status: "ARCHIVED",
      row_count: 4,
    });
    expect(byCompany.get(gone)).toMatchObject({
      status: "SKIPPED",
      row_count: 2,
    });

    const checked = await admin.query(
      "SELECT row_count::int AS row_count, objects FROM archive_partition WHERE partition_name = $1",
      [name],
    );

    expect(checked.rows).toEqual([{ row_count: 11, objects: 2 }]);
  });

  it("keeps the day when an upload is cut half-way, and the rerun writes one object per company", async () => {
    const day = expiredDay(6);
    const name = await attachDay(lean, day);
    const owner = await company();

    await points("driver_position_v2", owner, randomUUID(), day, 6);

    const storage = new InMemoryArchiveStorage();

    storage.failPutAfter = 10;

    const cut = await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(cut.driver_position_v2.held).toBeGreaterThanOrEqual(1);
    expect(await exists(name)).toBe(true);

    // The key was written down before the first byte went up.
    expect(await manifestOf(name)).toEqual([
      expect.objectContaining({ businessId: owner, status: "PENDING" }),
    ]);

    storage.failPutAfter = null;

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    const key = `trail/${dayKey(day)}/${owner}.csv.gz`;

    expect(await exists(name)).toBe(false);
    expect(storage.puts.filter((each) => each === key)).toHaveLength(1);
    expect(csvOf(storage, key)).toHaveLength(1 + 6);
    expect(await manifestOf(name)).toEqual([
      expect.objectContaining({ status: "ARCHIVED", row_count: 6 }),
    ]);
  });

  it("rewrites the same key when the manifest write was lost after the upload", async () => {
    const day = expiredDay(10);
    const name = await attachDay(lean, day);
    const owner = await company();

    await points("driver_position_v2", owner, randomUUID(), day, 3);

    const storage = new InMemoryArchiveStorage();
    let lose = true;
    const crashing: ArchiveDatabase = {
      $queryRawUnsafe: ((sql: string, ...params: unknown[]) =>
        databaseBatch.$queryRawUnsafe(sql, ...params)) as never,
      $executeRawUnsafe: ((sql: string, ...params: unknown[]) => {
        if (lose && sql.includes('UPDATE "archive_manifest"')) {
          lose = false;
          throw new Error("o processo morreu depois do envio");
        }

        return databaseBatch.$executeRawUnsafe(sql, ...params);
      }) as never,
    };

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage, { db: crashing }),
    });

    const key = `trail/${dayKey(day)}/${owner}.csv.gz`;

    expect(await exists(name)).toBe(true);
    expect(storage.objects.has(key)).toBe(true);

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(await exists(name)).toBe(false);
    // Written twice, one object: the key is the day and the company.
    expect(storage.puts.filter((each) => each === key)).toHaveLength(2);
    expect(
      [...storage.objects.keys()].filter((each) => each.includes(owner)),
    ).toEqual([key]);
    expect(await manifestOf(name)).toHaveLength(1);
  });

  it("keeps a day whose manifest does not add up", async () => {
    const day = expiredDay(14);
    const name = await attachDay(lean, day);
    const owner = await company();

    await points("driver_position_v2", owner, randomUUID(), day, 2);

    // A row for a company that exists but whose rows the day no longer
    // holds (deleted after an earlier archive): the sum overshoots the
    // count. A company that no longer exists would be the housekeeping's.
    await admin.query(
      `INSERT INTO archive_manifest (id, source_table, partition_name, "businessId",
         object_key, status, row_count, archived_at)
       VALUES ($1, 'driver_position_v2', $2, $3, 'trail/x.csv.gz', 'ARCHIVED', 3, now())`,
      [randomUUID(), name, await company()],
    );

    const storage = new InMemoryArchiveStorage();
    const outcome = await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(outcome.driver_position_v2.held).toBeGreaterThanOrEqual(1);
    expect(await exists(name)).toBe(true);

    const { rows } = await admin.query(
      "SELECT 1 FROM archive_partition WHERE partition_name = $1",
      [name],
    );

    expect(rows).toHaveLength(0);

    // Settled by hand (the runbook): the next night drops it.
    await admin.query(
      `DELETE FROM archive_manifest WHERE partition_name = $1 AND object_key = 'trail/x.csv.gz'`,
      [name],
    );
    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(await exists(name)).toBe(false);
  });

  it("keeps the day when the run is out of budget, and when the bucket is not configured", async () => {
    const day = expiredDay(18);
    const name = await attachDay(lean, day);
    const owner = await company();

    await points("driver_position_v2", owner, randomUUID(), day, 2);

    const storage = new InMemoryArchiveStorage();

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage, { deadline: Date.now() - 1 }),
    });

    expect(await exists(name)).toBe(true);
    expect(storage.puts).toEqual([]);

    const unconfigured = await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(null),
    });

    expect(unconfigured.driver_position_v2.held).toBeGreaterThanOrEqual(1);
    expect(await exists(name)).toBe(true);

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(await exists(name)).toBe(false);
    expect(storage.objects.has(`trail/${dayKey(day)}/${owner}.csv.gz`)).toBe(
      true,
    );
  });

  it("archives the legacy trail's day under legacy/", async () => {
    const day = expiredDay(22);
    const name = await attachDay(legacy, day);
    const owner = await company();
    const driver = randomUUID();

    await points("driver_position", owner, driver, day, 3);

    const storage = new InMemoryArchiveStorage();

    await maintainPartitions({
      tables: [legacy],
      trailArchive: gateWith(storage),
    });

    const key = `trail/${dayKey(day)}/legacy/${owner}.csv.gz`;

    expect(await exists(name)).toBe(false);
    expect(csvOf(storage, key).slice(1)).toHaveLength(3);
    expect(csvOf(storage, key)[1].startsWith(`${driver},`)).toBe(true);
  });

  it("drops a day detached on an earlier night only with its archive verified", async () => {
    const leftover = partitionName(lean, expiredDay(26));

    await admin.query(`CREATE TABLE "${leftover}" (LIKE driver_position_v2)`);

    const storage = new InMemoryArchiveStorage();
    const kept = await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(kept.driver_position_v2.held).toBeGreaterThanOrEqual(1);
    expect(await exists(leftover)).toBe(true);

    await admin.query(
      `INSERT INTO archive_partition (partition_name, source_table, row_count, objects)
       VALUES ($1, 'driver_position_v2', 0, 0)`,
      [leftover],
    );

    await maintainPartitions({
      tables: [lean],
      trailArchive: gateWith(storage),
    });

    expect(await exists(leftover)).toBe(false);
  });

  it("drops as before, unarchived, while the archive is off", async () => {
    const day = expiredDay(30);
    const name = await attachDay(lean, day);

    await points("driver_position_v2", await company(), randomUUID(), day, 1);

    const outcome = await maintainPartitions({
      tables: [lean],
      trailArchive: null,
    });

    expect(outcome.driver_position_v2).toMatchObject({ archived: 0, held: 0 });
    expect(await exists(name)).toBe(false);
    expect(await manifestOf(name)).toEqual([]);
  });
});

describe("deleteTrailArchive and the housekeeping", () => {
  it("deletes a company's objects with its manifest rows, and nobody else's", async () => {
    const storage = new InMemoryArchiveStorage();
    const [leaving, staying] = [randomUUID(), randomUUID()];

    for (const [businessId, day] of [
      [leaving, "20261001"],
      [leaving, "20261002"],
      [staying, "20261001"],
    ]) {
      const key = `trail/${day}/${businessId}.csv.gz`;

      storage.objects.set(key, Buffer.from("x"));
      await admin.query(
        `INSERT INTO archive_manifest (id, source_table, partition_name, "businessId",
           object_key, status, row_count, archived_at)
         VALUES ($1, 'driver_position_v2', $2, $3, $4, 'ARCHIVED', 1, now())`,
        [randomUUID(), `driver_position_v2_${day}`, businessId, key],
      );
    }

    expect(
      await deleteTrailArchive(leaving, { db: databaseBatch, storage }),
    ).toBe(2);
    expect([...storage.objects.keys()]).toEqual([
      `trail/20261001/${staying}.csv.gz`,
    ]);

    const { rows } = await admin.query<{ businessId: string }>(
      `SELECT "businessId" FROM archive_manifest WHERE "businessId" = ANY($1::text[])`,
      [[leaving, staying]],
    );

    expect(rows.map((row) => row.businessId)).toEqual([staying]);
  });

  it("removes the archives of companies that no longer exist, and purges what the bucket expired", async () => {
    const storage = new InMemoryArchiveStorage();
    const gone = randomUUID();
    const present = await company();
    const goneKey = `trail/20261003/${gone}.csv.gz`;
    const presentKey = `trail/20261003/${present}.csv.gz`;

    storage.objects.set(goneKey, Buffer.from("x"));
    storage.objects.set(presentKey, Buffer.from("y"));

    for (const [businessId, key] of [
      [gone, goneKey],
      [present, presentKey],
    ]) {
      await admin.query(
        `INSERT INTO archive_manifest (id, source_table, partition_name, "businessId",
           object_key, status, row_count, archived_at)
         VALUES ($1, 'driver_position_v2', 'driver_position_v2_20261003', $2, $3, 'ARCHIVED', 1, now())`,
        [randomUUID(), businessId, key],
      );
    }

    // Archived 200 days ago: its object is past the bucket's 180 days.
    const expiredKey = `trail/old/${present}.csv.gz`;

    await admin.query(
      `INSERT INTO archive_manifest (id, source_table, partition_name, "businessId",
         object_key, status, row_count, created_at, archived_at)
       VALUES ($1, 'driver_position_v2', 'driver_position_v2_old', $2, $3, 'ARCHIVED', 1,
               now() - interval '200 days', now() - interval '200 days')`,
      [randomUUID(), present, expiredKey],
    );

    await gateWith(storage).housekeeping();

    expect(storage.objects.has(goneKey)).toBe(false);
    expect(storage.objects.has(presentKey)).toBe(true);

    const { rows } = await admin.query<{ object_key: string }>(
      `SELECT object_key FROM archive_manifest WHERE object_key = ANY($1::text[]) ORDER BY 1`,
      [[goneKey, presentKey, expiredKey]],
    );

    expect(rows.map((row) => row.object_key)).toEqual([presentKey]);
  });

  it("treats a company whose purge started as gone, and a scheduled one as kept", async () => {
    // plano-escala F3-26a: from PURGING on, the company's archive goes
    // (the purge deletes it, the housekeeping catches what it missed); a
    // SCHEDULED company can still be reactivated with everything in place.
    const storage = new InMemoryArchiveStorage();
    const purged = await company();
    const scheduled = await company();

    await admin.query(
      `UPDATE business SET purge_state = 'PURGED' WHERE id = $1`,
      [purged],
    );
    await admin.query(
      `UPDATE business SET purge_state = 'SCHEDULED', purge_after = now() + interval '1 day' WHERE id = $1`,
      [scheduled],
    );

    for (const businessId of [purged, scheduled]) {
      const key = `trail/20261004/${businessId}.csv.gz`;

      storage.objects.set(key, Buffer.from("z"));
      await admin.query(
        `INSERT INTO archive_manifest (id, source_table, partition_name, "businessId",
           object_key, status, row_count, archived_at)
         VALUES ($1, 'driver_position_v2', 'driver_position_v2_20261004', $2, $3, 'ARCHIVED', 1, now())`,
        [randomUUID(), businessId, key],
      );
    }

    await gateWith(storage).housekeeping();

    expect([...storage.objects.keys()]).toEqual([
      `trail/20261004/${scheduled}.csv.gz`,
    ]);
  });
});

/** A bucket whose `failOn`-th upload dies half-way, once: a killed process. */
class DyingStorage extends InMemoryArchiveStorage {
  private calls = 0;

  constructor(private readonly failOn: number) {
    super();
  }

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    this.calls += 1;

    if (this.calls === this.failOn) {
      for await (const _chunk of body) {
        // The bytes went out; the connection did not survive.
      }

      throw new Error(`conexão perdida no envio de ${key}`);
    }

    return super.put(key, body);
  }
}

describe("the trail archive as a PARTITION_ARCHIVE job", () => {
  // plano-escala F3-28: the night no longer archives inside its own budget.
  // It enqueues the day's job and keeps the day; the job archives it on the
  // process that runs the `jobs` queue and, killed half-way, resumes from
  // the manifest without a second object; the day leaves on a later night,
  // with its manifest verified and no job of it still running.
  it("hands the day to the job, resumes a killed job and drops the day only after it", async () => {
    const day = expiredDay(34);
    const name = await attachDay(lean, day);
    const companies = [await company(), await company(), await company()];

    for (const businessId of companies) {
      await points("driver_position_v2", businessId, randomUUID(), day, 3);
    }

    const store = new BackgroundJobRepository(databaseBatch);
    const storage = new DyingStorage(2);
    const night = () =>
      maintainPartitions({
        tables: [lean],
        trailArchive: gateWith(storage, { jobs: partitionArchiveJobs(store) }),
      });

    await night();
    await night();

    // Kept, and handed to one job however many nights ask.
    expect(await exists(name)).toBe(true);
    expect(storage.puts).toEqual([]);

    const jobs = await admin.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM background_job
        WHERE kind = 'PARTITION_ARCHIVE' AND "subjectId" = $1`,
      [name],
    );

    expect(jobs.rows).toEqual([{ id: expect.any(String), status: "PENDING" }]);

    const runner = () => {
      const instance = new JobRunner({ store, owner: () => "e2e" });

      instance.register(
        "PARTITION_ARCHIVE",
        createPartitionArchiveJob({
          db: databaseBatch,
          storage: () => storage,
          pageSize: 2,
        }),
      );

      return instance;
    };

    // The second upload dies: the attempt fails, one object went up.
    expect(await runner().processBatch()).toBe(1);
    expect(storage.puts).toHaveLength(1);
    expect(await exists(name)).toBe(true);

    // The retry, without waiting for its backoff.
    await admin.query(
      `UPDATE background_job SET "availableAt" = now() WHERE id = $1`,
      [jobs.rows[0].id],
    );
    expect(await runner().processBatch()).toBe(1);

    const settled = await admin.query<{ status: string }>(
      `SELECT status::text AS status FROM background_job WHERE id = $1`,
      [jobs.rows[0].id],
    );

    expect(settled.rows[0].status).toBe("SUCCEEDED");

    // One object per company, none twice.
    const keys = companies.map(
      (businessId) => `trail/${dayKey(day)}/${businessId}.csv.gz`,
    );

    expect([...storage.puts].sort()).toEqual([...keys].sort());

    // The next night drops the day.
    await night();

    expect(await exists(name)).toBe(false);
  });
});
