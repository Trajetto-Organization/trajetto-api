import { resolve } from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
  type ReleaseStep,
} from "infra/scripts/release-step-runner";

/**
 * The runtime's database roles (plano-escala F3-19):
 * infra/sql/20-runtime-roles.sql, which every release reapplies.
 *
 * Today the runtime connects as the owner of every table, a superuser. The
 * cut gives each process a role with only what it needs, and the step is
 * what makes "only" true on every release, after a restore with
 * --no-owner as well: a table the runtime cannot write breaks a feature,
 * and a table it can write too much is the hole the cut closes. So the
 * whole catalog is checked, not a sample: every table of the schema, as
 * each role really sees it (has_table_privilege, memberships included).
 *
 * Run as the release step runs it: the real file, through the real runner,
 * on this file's database. Roles belong to the cluster, shared with every
 * other E2E file running beside this one: nothing here changes a role or
 * a membership, only this database's grants.
 */
const URL = () => process.env.DATABASE_URL as string;
const STEP = "infra/sql/20-runtime-roles.sql";

const ROLES = [
  "trajetto_app",
  "trajetto_http",
  "trajetto_worker",
  "trajetto_batch",
  "trajetto_read",
] as const;

const TRAIL = new Set(["delivery_event", "delivery_event_part"]);
const RELEASE_TABLES = new Set([
  "_prisma_migrations",
  "release_step_state",
  "cluster_epoch",
]);
const GPS_COLUMNS = ["gps_address", "gps_address_source", "gps_geocoded_at"];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

type Privilege = (typeof PRIVILEGES)[number];

let admin: pg.Client;
let step: ReleaseStep;

const log = { info: () => undefined, warn: () => undefined };

async function runStep() {
  const client = await openReleaseClient(URL(), "e2e-database-roles");

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

/**
 * Every ACL the step manages, one line per privilege, sorted: tables and
 * sequences, columns, default privileges. Two equal snapshots are two
 * equal catalogs, whatever order the entries were granted in.
 */
async function snapshot(): Promise<string> {
  const { rows } = await admin.query<{ line: string }>(
    `SELECT concat_ws(' ', 'rel', c.relname, x.grantee::regrole, x.privilege_type, x.grantor::regrole) AS line
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      WHERE c.relnamespace = to_regnamespace(current_schema())
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     UNION ALL
     SELECT concat_ws(' ', 'col', c.relname || '.' || a.attname, x.grantee::regrole, x.privilege_type)
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relnamespace = to_regnamespace(current_schema())
        AND a.attacl IS NOT NULL
     UNION ALL
     SELECT concat_ws(' ', 'default', d.defaclobjtype, x.grantee::regrole, x.privilege_type)
       FROM pg_default_acl d
       CROSS JOIN LATERAL aclexplode(d.defaclacl) x
      WHERE d.defaclnamespace = to_regnamespace(current_schema())
     ORDER BY 1`,
  );

  return rows.map((row) => row.line).join("\n");
}

/** What each role may do to `table`, as Postgres answers for it. */
async function effective(
  role: string,
  table: string,
): Promise<Record<Privilege, boolean>> {
  const { rows } = await admin.query<Record<Privilege, boolean>>(
    `SELECT has_table_privilege($1, $2::regclass, 'SELECT') AS "SELECT",
            has_table_privilege($1, $2::regclass, 'INSERT') AS "INSERT",
            has_table_privilege($1, $2::regclass, 'UPDATE') AS "UPDATE",
            has_table_privilege($1, $2::regclass, 'DELETE') AS "DELETE"`,
    [role, `"${table}"`],
  );

  return rows[0];
}

/**
 * What the plan says `role` may do to `table` (F3-19), effectively. A
 * table trajetto_partitions owns is batch's to do anything with: batch is
 * a member of its owner, which is how the partition job runs its DDL.
 */
function expectedFor(
  role: string,
  table: string,
  owner = "",
): Record<Privilege, boolean> {
  const set = (granted: Privilege[]) =>
    Object.fromEntries(
      PRIVILEGES.map((privilege) => [privilege, granted.includes(privilege)]),
    ) as Record<Privilege, boolean>;

  if (role === "trajetto_read") return set(["SELECT"]);

  if (role === "trajetto_batch" && owner === "trajetto_partitions") {
    return set([...PRIVILEGES]);
  }

  if (TRAIL.has(table)) {
    if (role === "trajetto_batch") return set(["SELECT", "UPDATE", "DELETE"]);
    if (role === "trajetto_app") return set([]);

    return set(["SELECT", "INSERT"]);
  }

  if (RELEASE_TABLES.has(table)) return set(["SELECT"]);

  return set([...PRIVILEGES]);
}

/** Runs `sql` as `role` (SET LOCAL ROLE) and returns the SQLSTATE, or null. */
async function asRole(role: string, sql: string): Promise<string | null> {
  await admin.query("BEGIN");

  try {
    await admin.query(`SET LOCAL ROLE ${role}`);
    await admin.query(sql);

    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await admin.query("ROLLBACK");
  }
}

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-database-roles-admin");

  const found = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === STEP,
  );

  if (!found) throw new Error(`${STEP} não foi encontrado`);

  step = found;
});

afterAll(async () => {
  await admin.end();
});

describe("infra/sql/20-runtime-roles.sql", () => {
  it("left the template with the five roles, none of them a login", async () => {
    const { rows } = await admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolname::text, rolcanlogin, rolsuper
         FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`,
      [[...ROLES]],
    );

    expect(rows.map((row) => row.rolname).sort()).toEqual([...ROLES].sort());

    // A release never opens a door: login and password are the owner's.
    for (const row of rows) {
      expect(row, row.rolname).toMatchObject({
        rolcanlogin: false,
        rolsuper: false,
      });
    }

    const { rows: state } = await admin.query<{ status: string }>(
      "SELECT status FROM release_step_state WHERE step = $1",
      [STEP],
    );

    expect(state).toEqual([{ status: "applied" }]);
  });

  it("puts http, worker and batch in the group, never read, and batch in the owner and statistics roles", async () => {
    const { rows } = await admin.query<Record<string, boolean>>(
      `SELECT pg_has_role('trajetto_http', 'trajetto_app', 'MEMBER') AS http,
              pg_has_role('trajetto_worker', 'trajetto_app', 'MEMBER') AS worker,
              pg_has_role('trajetto_batch', 'trajetto_app', 'MEMBER') AS batch,
              pg_has_role('trajetto_read', 'trajetto_app', 'MEMBER') AS read,
              pg_has_role('trajetto_batch', 'trajetto_partitions', 'MEMBER') AS partitions,
              pg_has_role('trajetto_batch', 'pg_read_all_stats', 'MEMBER') AS stats,
              pg_has_role('trajetto_batch', 'pg_monitor', 'MEMBER') AS monitor,
              pg_has_role('trajetto_http', 'trajetto_partitions', 'MEMBER') AS http_partitions`,
    );

    expect(rows[0]).toEqual({
      http: true,
      worker: true,
      batch: true,
      read: false,
      partitions: true,
      stats: true,
      monitor: true,
      http_partitions: false,
    });
  });

  it("sets each role's ceilings, the same as today's URL and each pool's statement", async () => {
    const { rows } = await admin.query<{ role: string; config: string[] }>(
      `SELECT r.rolname::text AS role, s.setconfig AS config
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole
        WHERE s.setdatabase = 0 AND r.rolname = ANY($1::text[])`,
      [[...ROLES]],
    );
    const config = Object.fromEntries(
      rows.map((row) => [row.role, [...row.config].sort()]),
    );
    const ceilings = (statement: string) =>
      [
        "idle_in_transaction_session_timeout=60s",
        "lock_timeout=5s",
        `statement_timeout=${statement}`,
      ].sort();

    expect(config).toEqual({
      trajetto_http: ceilings("30s"),
      trajetto_worker: ceilings("30s"),
      trajetto_batch: ceilings("30min"),
      trajetto_read: ceilings("10s"),
    });
  });

  it("gives every table of the catalog exactly the grants the plan names", async () => {
    const { rows: tables } = await admin.query<{
      relname: string;
      owner: string;
    }>(
      `SELECT relname::text, pg_get_userbyid(relowner)::text AS owner
         FROM pg_class
        WHERE relnamespace = to_regnamespace(current_schema())
          AND relkind IN ('r', 'p') AND NOT relispartition
        ORDER BY 1`,
    );

    expect(tables.length).toBeGreaterThan(50);
    expect(tables.map((row) => row.relname)).toContain("delivery_event");

    const wrong: string[] = [];

    for (const { relname, owner } of tables) {
      for (const role of ROLES) {
        const actual = await effective(role, relname);
        const expected = expectedFor(role, relname, owner);

        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          wrong.push(`${role} em ${relname}: ${JSON.stringify(actual)}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("lets http and worker fill in only the GPS address of the trail", async () => {
    const { rows } = await admin.query<{
      role: string;
      column: string;
      can: boolean;
    }>(
      `SELECT r.role, a.attname::text AS column,
              has_column_privilege(r.role, 'delivery_event'::regclass, a.attname, 'UPDATE') AS can
         FROM unnest(ARRAY['trajetto_http', 'trajetto_worker']) AS r(role)
         CROSS JOIN pg_attribute a
        WHERE a.attrelid = 'delivery_event'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    );

    const updatable = rows
      .filter((row) => row.can)
      .map((row) => `${row.role}.${row.column}`)
      .sort();

    expect(updatable).toEqual(
      ["trajetto_http", "trajetto_worker"]
        .flatMap((role) => GPS_COLUMNS.map((column) => `${role}.${column}`))
        .sort(),
    );
  });

  it("refuses with 42501 what each role may not do", async () => {
    // The trail's history, rewritten by a request: the hole of the cut.
    expect(
      await asRole(
        "trajetto_http",
        `UPDATE "delivery_event" SET "type" = 'NOTE' WHERE false`,
      ),
    ).toBe("42501");
    expect(
      await asRole("trajetto_http", `DELETE FROM "delivery_event" WHERE false`),
    ).toBe("42501");
    // The address of a proof, as the proof document caches it: allowed.
    expect(
      await asRole(
        "trajetto_http",
        `UPDATE "delivery_event" SET "gps_geocoded_at" = now() WHERE false`,
      ),
    ).toBeNull();
    // The heavy reads write nothing.
    expect(
      await asRole("trajetto_read", `DELETE FROM "user" WHERE false`),
    ).toBe("42501");
    expect(
      await asRole(
        "trajetto_read",
        `UPDATE "business" SET "city" = "city" WHERE false`,
      ),
    ).toBe("42501");
    expect(
      await asRole("trajetto_read", `SELECT count(*) FROM "delivery_event"`),
    ).toBeNull();
    // The release's own bookkeeping is read-only for the runtime.
    expect(
      await asRole("trajetto_http", `DELETE FROM "release_step_state"`),
    ).toBe("42501");
    // A partition is reached only through its parent.
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'driver_position'::regclass LIMIT 1`,
    );

    expect(rows).toHaveLength(1);
    expect(
      await asRole(
        "trajetto_http",
        `SELECT count(*) FROM "${rows[0].relname}"`,
      ),
    ).toBe("42501");
    expect(
      await asRole("trajetto_http", `SELECT count(*) FROM "driver_position"`),
    ).toBeNull();
    // The webhook sequence, as the dispatcher takes it.
    expect(
      await asRole("trajetto_worker", `SELECT nextval('webhook_event_seq')`),
    ).toBeNull();
  });

  it("gives a table a later migration creates the same grants, through the default privileges", async () => {
    await admin.query(`CREATE TABLE "e2e_roles_later" ("id" text PRIMARY KEY)`);
    await admin.query(`CREATE SEQUENCE "e2e_roles_later_seq"`);

    try {
      expect(await effective("trajetto_http", "e2e_roles_later")).toEqual(
        expectedFor("trajetto_http", "e2e_roles_later"),
      );
      expect(await effective("trajetto_read", "e2e_roles_later")).toEqual(
        expectedFor("trajetto_read", "e2e_roles_later"),
      );

      const { rows } = await admin.query<{ usage: boolean }>(
        `SELECT has_sequence_privilege('trajetto_http', 'e2e_roles_later_seq', 'USAGE') AS usage`,
      );

      expect(rows[0].usage).toBe(true);
    } finally {
      await admin.query(`DROP TABLE "e2e_roles_later"`);
      await admin.query(`DROP SEQUENCE "e2e_roles_later_seq"`);
    }
  });

  it("converges again after the grants drift, and the second run changes nothing", async () => {
    const converged = await snapshot();

    // Twice on a converged database: nothing to do, nothing changed.
    expect(await runStep()).toMatchObject({ status: "skipped" });
    expect(await snapshot()).toBe(converged);

    // As a restore with --no-owner, or a grant made by hand, leaves it.
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'driver_position'::regclass LIMIT 1`,
    );

    await admin.query(`REVOKE ALL ON TABLE "vehicle" FROM trajetto_app`);
    await admin.query(`GRANT TRUNCATE ON TABLE "user" TO trajetto_app`);
    await admin.query(
      `GRANT UPDATE ON TABLE "delivery_event" TO trajetto_http`,
    );
    await admin.query(
      `GRANT UPDATE ("type") ON "delivery_event" TO trajetto_worker`,
    );
    await admin.query(
      `GRANT INSERT ON TABLE "_prisma_migrations" TO trajetto_app`,
    );
    await admin.query(
      `GRANT SELECT ON TABLE "${rows[0].relname}" TO trajetto_read`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${await schemaName()}" REVOKE INSERT ON TABLES FROM trajetto_app`,
    );

    expect(await snapshot()).not.toBe(converged);

    const repaired = await runStep();

    expect(repaired.status).toBe("applied");
    expect(await snapshot()).toBe(converged);

    // And once converged, quiet again.
    expect(await runStep()).toMatchObject({ status: "skipped" });
    expect(await snapshot()).toBe(converged);
  });
});

async function schemaName(): Promise<string> {
  const { rows } = await admin.query<{ schema: string }>(
    "SELECT current_schema()::text AS schema",
  );

  return rows[0].schema;
}
