import { resolve } from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
  type ReleaseStep,
} from "infra/scripts/release-step-runner";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  PARTITION_OWNER_ROLE,
  asPartitionOwner,
} from "@/shared/database/partition-owner";

/**
 * trajetto_partitions owns the partitioned tables and every partition
 * (plano-escala F2-07): infra/sql/10-partitions.sql, which every release
 * reapplies, and the SET LOCAL ROLE the partition job runs under.
 *
 * Why it matters: once the runtime connects as trajetto_batch instead of a
 * superuser (F3-19/F3-21), ATTACH, DETACH and DROP of a partition need its
 * OWNER, and the only owner the batch login can act as is this role. A
 * partition left with another owner (made by hand in an incident, or before
 * the step ran) would stop the nightly job from dropping it, and a parent
 * left behind would stop it from creating tomorrow's.
 *
 * Run as the release step runs it: the real file, through the real runner,
 * on this file's database, twice. The role belongs to the cluster, so it is
 * never dropped here.
 */
const URL = () => process.env.DATABASE_URL as string;
const STEP = "infra/sql/10-partitions.sql";

const prisma = createPrismaClient({ log: [] });
let admin: pg.Client;
let step: ReleaseStep;
const lines: string[] = [];

const log = {
  info: (message: string) => lines.push(`info ${message}`),
  warn: (message: string) => lines.push(`warn ${message}`),
};

async function runStep() {
  const client = await openReleaseClient(URL(), "e2e-partition-owner");

  try {
    const outcome = await runReleaseSteps(client, [step], {
      log,
      postDeploy: false,
    });

    return outcome.steps[0];
  } finally {
    await client.end();
  }
}

/** Every table of driver_position's tree whose owner is not the role. */
async function notOwned(): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `SELECT c.relname::text AS relname
       FROM pg_partition_tree('driver_position') t
       JOIN pg_class c ON c.oid = t.relid
      WHERE pg_get_userbyid(c.relowner) <> $1
      ORDER BY 1`,
    [PARTITION_OWNER_ROLE],
  );

  return rows.map((row) => row.relname);
}

async function partitions(): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `SELECT c.relname::text AS relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'driver_position'::regclass
      ORDER BY 1`,
  );

  return rows.map((row) => row.relname);
}

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-partition-owner-admin");

  const found = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === STEP,
  );

  if (!found) throw new Error(`${STEP} não foi encontrado`);

  step = found;
});

afterAll(async () => {
  await admin.end();
  await prisma.$disconnect();
});

describe("infra/sql/10-partitions.sql", () => {
  it("left the E2E template with the role owning the parent and every partition", async () => {
    // The clone is a database as a release leaves it.
    expect(await partitions()).not.toEqual([]);
    expect(await notOwned()).toEqual([]);

    const { rows } = await admin.query<{ create: boolean; usage: boolean }>(
      `SELECT has_schema_privilege($1, current_schema(), 'CREATE') AS create,
              has_schema_privilege($1, current_schema(), 'USAGE') AS usage`,
      [PARTITION_OWNER_ROLE],
    );

    expect(rows[0]).toEqual({ create: true, usage: true });

    const role = await admin.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
      [PARTITION_OWNER_ROLE],
    );

    // Never a login: a release must not open a door into the database.
    expect(role.rows).toEqual([{ rolcanlogin: false }]);
  });

  it("gives the parent and every partition back to the role, and does nothing the second time", async () => {
    const [first] = await partitions();

    // As a restore with --no-owner leaves them, and as a partition made by
    // hand in an incident is born.
    await admin.query(`ALTER TABLE "driver_position" OWNER TO current_user`);
    await admin.query(`ALTER TABLE "${first}" OWNER TO current_user`);
    await admin.query(
      `CREATE TABLE "driver_position_20000101" PARTITION OF "driver_position"
         FOR VALUES FROM ('2000-01-01') TO ('2000-01-02')`,
    );

    expect(await notOwned()).toEqual(
      ["driver_position", "driver_position_20000101", first].sort(),
    );

    const applied = await runStep();

    expect(applied).toEqual({
      step: STEP,
      status: "applied",
      detail: "3 tabela(s) passaram ao trajetto_partitions",
    });
    expect(await notOwned()).toEqual([]);

    // The second run takes no lock and changes nothing.
    const again = await runStep();

    expect(again).toMatchObject({ step: STEP, status: "skipped" });
    expect(again?.detail).toContain("driver_position");

    await admin.query(`DROP TABLE "driver_position_20000101"`);
  });

  it("leaves a table whose lock does not come to the next release, quickly", async () => {
    const all = await partitions();
    const busy = all[all.length - 1];

    await admin.query(`ALTER TABLE "${busy}" OWNER TO current_user`);

    // A reader in the middle of a transaction on that partition, as a
    // long report or pg_dump would be: ALTER OWNER needs ACCESS EXCLUSIVE.
    const reader = await openReleaseClient(URL(), "e2e-partition-reader");

    try {
      await reader.query("BEGIN");
      await reader.query(`SELECT count(*) FROM "${busy}"`);

      const startedAt = Date.now();
      const pending = await runStep();
      const elapsed = Date.now() - startedAt;

      expect(pending).toMatchObject({ step: STEP, status: "pending" });
      expect(pending?.detail).toContain(busy);
      expect(elapsed, `levou ${elapsed} ms`).toBeLessThan(8_000);
      expect(await notOwned()).toEqual([busy]);
    } finally {
      await reader.query("ROLLBACK").catch(() => undefined);
      await reader.end();
    }

    // The state the next release reads, and what it does once the lock
    // comes.
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM release_step_state WHERE step = $1",
      [STEP],
    );

    expect(rows).toEqual([{ status: "pending" }]);
    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await notOwned()).toEqual([]);
  });
});

describe("asPartitionOwner", () => {
  it("runs the transaction as the role where the role owns the parent, and only there", async () => {
    const inside = await prisma.$transaction(async (tx) => {
      const asOwner = await asPartitionOwner(tx, "driver_position");
      const [row] = await tx.$queryRaw<Array<{ who: string }>>`
        SELECT current_user::text AS who
      `;

      return { asOwner, who: row.who };
    });

    expect(inside).toEqual({ asOwner: true, who: PARTITION_OWNER_ROLE });

    // SET LOCAL: the pooled connection comes back as it went.
    const [after] = await prisma.$queryRaw<Array<{ who: string }>>`
      SELECT current_user::text AS who
    `;

    expect(after.who).not.toBe(PARTITION_OWNER_ROLE);
  });

  it("stays as the session's user where the parent has another owner", async () => {
    await admin.query(
      `CREATE TABLE wfl_owner_probe (at timestamp(3) NOT NULL)
         PARTITION BY RANGE (at)`,
    );

    try {
      const inside = await prisma.$transaction(async (tx) => {
        const asOwner = await asPartitionOwner(tx, "wfl_owner_probe");
        const [row] = await tx.$queryRaw<Array<{ who: string }>>`
          SELECT current_user::text AS who
        `;

        return { asOwner, who: row.who };
      });

      expect(inside.asOwner).toBe(false);
      expect(inside.who).not.toBe(PARTITION_OWNER_ROLE);

      // And a table that does not exist is not an error: it is "no".
      const missing = await prisma.$transaction((tx) =>
        asPartitionOwner(tx, "wfl_no_such_table"),
      );

      expect(missing).toBe(false);
    } finally {
      await admin.query("DROP TABLE wfl_owner_probe");
    }
  });

  it("makes a partition the role owns, so it can be attached and dropped without a superuser", async () => {
    const owner = await prisma.$transaction(async (tx) => {
      await asPartitionOwner(tx, "driver_position");
      await tx.$executeRawUnsafe(
        `CREATE TABLE "driver_position_20000102" (LIKE "driver_position")`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "driver_position" ATTACH PARTITION "driver_position_20000102"
           FOR VALUES FROM ('2000-01-02') TO ('2000-01-03')`,
      );

      const [row] = await tx.$queryRaw<Array<{ owner: string }>>`
        SELECT pg_get_userbyid(relowner)::text AS owner
        FROM pg_class WHERE oid = '"driver_position_20000102"'::regclass
      `;

      return row.owner;
    });

    expect(owner).toBe(PARTITION_OWNER_ROLE);
    expect(await partitions()).toContain("driver_position_20000102");

    await admin.query(`DROP TABLE "driver_position_20000102"`);
  });
});
