import { resolve } from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
} from "infra/scripts/release-step-runner";

/**
 * No code in the schema from a role that is not the tables' owner
 * (infra/sql/15-untrusted-code.sql; the security review of plano-escala
 * F3-19 and F1-25).
 *
 * trajetto_partitions has CREATE on the schema, for tomorrow's partitions,
 * and trajetto_batch — the cron's login after the cut — is a member of it.
 * Whoever holds the batch credentials could put a better-matching overload
 * in the schema (CVE-2018-1058): the release step and the migrations run
 * as the Database's superuser with that schema on their search_path, and
 * a public.array_to_string(text[], text) would run as the superuser on the
 * next release, close enough to read the PITR keys and delete the
 * backups. The event trigger refuses that DDL before it runs, and lets the
 * partition job's own (CREATE, ALTER and DROP TABLE) through.
 *
 * Run as the release step runs it: the real file, through the real runner,
 * on this file's database. Event triggers belong to the database, so this
 * file may drop its own; the roles are the cluster's and never change.
 */
const URL = () => process.env.DATABASE_URL as string;
const STEP = "infra/sql/15-untrusted-code.sql";
const TRIGGER = "trajetto_untrusted_code";
const FUNCTION = "trajetto_refuse_untrusted_code";

let admin: pg.Client;

/** Runs `sql` as `role` (SET LOCAL ROLE), rolled back; the SQLSTATE or null. */
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

async function runStep() {
  const step = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === STEP,
  );

  if (!step) throw new Error(`${STEP} não foi encontrado`);

  const client = await openReleaseClient(URL(), "e2e-untrusted-code");

  try {
    const outcome = await runReleaseSteps(client, [step], {
      log: { info: () => undefined, warn: () => undefined },
      postDeploy: false,
    });

    return outcome.steps[0];
  } finally {
    await client.end();
  }
}

/** The trigger as the catalog has it, and who owns its function. */
async function guard(): Promise<{
  enabled: string;
  functionOwnerIsSuperuser: boolean;
} | null> {
  const { rows } = await admin.query<{
    enabled: string;
    functionOwnerIsSuperuser: boolean;
  }>(
    `SELECT e.evtenabled::text AS enabled,
            r.rolsuper AS "functionOwnerIsSuperuser"
       FROM pg_event_trigger e
       JOIN pg_proc p ON p.oid = e.evtfoid
       JOIN pg_roles r ON r.oid = p.proowner
      WHERE e.evtname = $1 AND p.proname = $2`,
    [TRIGGER, FUNCTION],
  );

  return rows[0] ?? null;
}

const HIJACK = `CREATE FUNCTION public.array_to_string(text[], text)
  RETURNS text LANGUAGE sql AS $f$ SELECT 'x' $f$`;

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-untrusted-code-admin");
});

afterAll(async () => {
  await admin.end();
});

describe("infra/sql/15-untrusted-code.sql", () => {
  it("refuses code planted in the schema by the partitions' owner or the batch login", async () => {
    for (const role of ["trajetto_partitions", "trajetto_batch"]) {
      expect(await asRole(role, HIJACK), role).toBe("42501");
    }

    for (const [what, sql] of [
      [
        "an operator",
        `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = pg_catalog.texteq)`,
      ],
      [
        "a trigger on a table the role owns",
        `CREATE TRIGGER wfl_probe BEFORE INSERT ON "driver_position"
           FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()`,
      ],
      [
        "a rule on a table the role owns",
        `CREATE RULE wfl_probe AS ON INSERT TO "driver_position" DO ALSO NOTIFY wfl_probe`,
      ],
      [
        "a range type, whose constructor is a function",
        `CREATE TYPE public.wfl_probe AS RANGE (subtype = text)`,
      ],
    ]) {
      expect(await asRole("trajetto_partitions", sql), what).toBe("42501");
    }
  });

  it("lets the partition job's DDL through, and every DDL of the superuser", async () => {
    expect(
      await asRole(
        "trajetto_partitions",
        `CREATE TABLE wfl_guard_probe (at int);
         ALTER TABLE wfl_guard_probe ADD COLUMN later int;
         DROP TABLE wfl_guard_probe;`,
      ),
    ).toBeNull();

    // The migrations and the release step: the Database's user.
    await admin.query("BEGIN");

    try {
      await admin.query(
        `CREATE FUNCTION wfl_guard_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("left the template with the trigger on, its function a superuser's, and changes nothing the second time", async () => {
    expect(await guard()).toEqual({
      enabled: "O",
      functionOwnerIsSuperuser: true,
    });
    expect(await runStep()).toMatchObject({ step: STEP, status: "skipped" });
  });

  it("converges again: a disabled trigger is enabled, a dropped one comes back", async () => {
    await admin.query(`ALTER EVENT TRIGGER ${TRIGGER} DISABLE`);

    expect(await runStep()).toMatchObject({ status: "applied" });
    expect((await guard())?.enabled).toBe("O");

    await admin.query(`DROP EVENT TRIGGER ${TRIGGER}`);

    expect(await asRole("trajetto_partitions", HIJACK)).toBeNull();
    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await asRole("trajetto_partitions", HIJACK)).toBe("42501");
  });

  it("takes its function back from a role that made one under the same name first", async () => {
    // As an attacker who got there before the step: a no-op under the
    // guard's name, owned by the role, which could rewrite it later.
    await admin.query(`DROP EVENT TRIGGER ${TRIGGER}`);
    await admin.query(`DROP FUNCTION ${FUNCTION}()`);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL ROLE trajetto_partitions");
    await admin.query(
      `CREATE FUNCTION ${FUNCTION}() RETURNS event_trigger
         LANGUAGE plpgsql AS $f$ BEGIN END $f$`,
    );
    await admin.query("COMMIT");

    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await guard()).toEqual({
      enabled: "O",
      functionOwnerIsSuperuser: true,
    });
    expect(await asRole("trajetto_partitions", HIJACK)).toBe("42501");
  });
});
