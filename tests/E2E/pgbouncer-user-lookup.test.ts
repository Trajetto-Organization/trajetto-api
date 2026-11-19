import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
} from "infra/scripts/release-step-runner";

/**
 * PgBouncer's auth_query (infra/sql/30-pgbouncer-auth.sql; plano-escala
 * F4-33 and its security review).
 *
 * PgBouncer reads the SCRAM verifier of whoever logs in through
 * `SELECT * FROM pgbouncer.user_lookup($1)`, as pgbouncer_auth. The
 * function reads pg_authid, so it runs as a superuser (SECURITY DEFINER):
 * without the REVOKE from PUBLIC, an SQL injection as trajetto_http would
 * read every verifier and try them offline; without the exclusions,
 * PgBouncer would let the owner of the tables (a superuser) in through the
 * pool.
 *
 * Run as the release step runs it: the real file, through the real runner,
 * on this file's database. The schema and the function belong to this
 * database, so the file may break and rebuild them. The roles are the
 * cluster's: every change to one (a login, a password, a probe role) is
 * made inside a transaction that is rolled back.
 */
const URL = () => process.env.DATABASE_URL as string;
const STEP = "infra/sql/30-pgbouncer-auth.sql";
const LOOKUP = "pgbouncer.user_lookup";
const AUTH_ROLE = "pgbouncer_auth";

let admin: pg.Client;

const secret = () => randomBytes(18).toString("hex");
const probeRole = (what: string) =>
  `wfl_lookup_${what}_${randomBytes(4).toString("hex")}`;

async function runStep() {
  const step = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === STEP,
  );

  if (!step) throw new Error(`${STEP} não foi encontrado`);

  const client = await openReleaseClient(URL(), "e2e-pgbouncer-user-lookup");

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

/** Runs `work` inside a transaction that is always rolled back. */
async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
  await admin.query("BEGIN");

  try {
    return await work();
  } finally {
    await admin.query("ROLLBACK");
  }
}

/** What PgBouncer gets for `name`, asked as pgbouncer_auth (inside a transaction). */
async function lookup(
  name: string,
): Promise<Array<{ usename: string; passwd: string }>> {
  await admin.query(`SET LOCAL ROLE ${AUTH_ROLE}`);

  try {
    const { rows } = await admin.query<{ usename: string; passwd: string }>(
      `SELECT usename::text AS usename, passwd FROM ${LOOKUP}($1)`,
      [name],
    );

    return rows;
  } finally {
    await admin.query("RESET ROLE");
  }
}

/** Runs `sql` as `role` after `before` (as the superuser), rolled back; the SQLSTATE or null. */
async function codeAs(
  role: string,
  sql: string,
  before = "",
): Promise<string | null> {
  await admin.query("BEGIN");

  try {
    if (before) await admin.query(before);
    await admin.query(`SET LOCAL ROLE ${role}`);
    await admin.query(sql);

    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await admin.query("ROLLBACK");
  }
}

/** The lookup as the catalog has it; null when there is none. */
async function state() {
  const { rows } = await admin.query<{
    ownerIsSuperuser: boolean;
    schemaOwnerIsSuperuser: boolean;
    securityDefiner: boolean;
    config: string[] | null;
    functionGrants: string[];
    schemaGrants: string[];
    sameName: number;
  }>(
    `SELECT r.rolsuper AS "ownerIsSuperuser",
            sr.rolsuper AS "schemaOwnerIsSuperuser",
            p.prosecdef AS "securityDefiner",
            p.proconfig AS config,
            ARRAY(
              SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                     || '=' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
                FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee <> p.proowner
               ORDER BY 1
            ) AS "functionGrants",
            ARRAY(
              SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                     || '=' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
                FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
               WHERE a.grantee <> n.nspowner
               ORDER BY 1
            ) AS "schemaGrants",
            (SELECT count(*)::int FROM pg_proc o
              WHERE o.pronamespace = n.oid AND o.proname = 'user_lookup') AS "sameName"
       FROM pg_proc p
       JOIN pg_roles r ON r.oid = p.proowner
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles sr ON sr.oid = n.nspowner
      WHERE p.oid = to_regprocedure('${LOOKUP}(text)')`,
  );

  return rows[0] ?? null;
}

/** The name the sessions of pgbouncer_auth carry by its role's default. */
const AUTH_SESSION_NAME = "trajetto-pgbouncer-auth";

/** pgbouncer_auth's default application_name, for every database. */
async function authSessionName(): Promise<string | null> {
  const { rows } = await admin.query<{ name: string | null }>(
    `SELECT (
       SELECT split_part(c, '=', 2)
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole,
              unnest(s.setconfig) c
        WHERE r.rolname = $1
          AND s.setdatabase = 0
          AND c LIKE 'application\\_name=%'
     ) AS name`,
    [AUTH_ROLE],
  );

  return rows[0]?.name ?? null;
}

const CLOSED = {
  ownerIsSuperuser: true,
  schemaOwnerIsSuperuser: true,
  securityDefiner: true,
  config: ["search_path=pg_catalog, pg_temp"],
  functionGrants: [`${AUTH_ROLE}=EXECUTE`],
  schemaGrants: [`${AUTH_ROLE}=USAGE`],
  sameName: 1,
};

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-pgbouncer-user-lookup-admin");
});

afterAll(async () => {
  await admin.end();
});

describe("infra/sql/30-pgbouncer-auth.sql", () => {
  it("left the template with the lookup a superuser's, open only to pgbouncer_auth, and changes nothing the second time", async () => {
    expect(await state()).toEqual(CLOSED);

    const { rows } = await admin.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = $1`,
      [AUTH_ROLE],
    );

    expect(rows).toEqual([{ rolsuper: false }]);
    expect(await authSessionName()).toBe(AUTH_SESSION_NAME);
    expect(await runStep()).toMatchObject({ step: STEP, status: "skipped" });
  });

  /**
   * PgBouncer sends no application_name for the sessions it opens as
   * pgbouncer_auth (the auth_query's), and the release's
   * trajetto_capability_ready reads an unnamed session in the database as
   * the image from before the scale plan, holding every contraction back
   * while PgBouncer runs. The role's default names them; the step puts it
   * back when it goes. Inside a transaction rolled back: the role is the
   * cluster's.
   */
  it("names the auth login's sessions by a default of the role, and puts it back when it goes", async () => {
    await admin.query("BEGIN");

    try {
      await admin.query(`ALTER ROLE ${AUTH_ROLE} RESET application_name`);
      expect(await authSessionName()).toBeNull();

      await admin.query(readFileSync(resolve(process.cwd(), STEP), "utf8"));
      expect(await authSessionName()).toBe(AUTH_SESSION_NAME);
    } finally {
      await admin.query("ROLLBACK");
    }

    // Never on a runtime role: an unnamed session of theirs is the old
    // image the check must keep seeing.
    const { rows } = await admin.query<{ rolname: string }>(
      `SELECT r.rolname
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname LIKE 'trajetto\\_%'
          AND EXISTS (
            SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'application\\_name=%'
          )`,
    );

    expect(rows).toEqual([]);
  });

  it("serves the SCRAM verifier of a runtime login, and nothing for the owner nor for the roles it must never serve", async () => {
    await rolledBack(async () => {
      await admin.query("SET LOCAL password_encryption = 'scram-sha-256'");
      await admin.query(
        `ALTER ROLE trajetto_http LOGIN PASSWORD '${secret()}'`,
      );

      const verifier = await admin.query<{ rolpassword: string }>(
        `SELECT rolpassword FROM pg_authid WHERE rolname = 'trajetto_http'`,
      );

      expect(verifier.rows[0].rolpassword).toMatch(/^SCRAM-SHA-256\$/);
      expect(await lookup("trajetto_http")).toEqual([
        { usename: "trajetto_http", passwd: verifier.rows[0].rolpassword },
      ]);

      // A login like any other, to show a probe role is served at all.
      const plain = probeRole("plain");

      await admin.query(`CREATE ROLE ${plain} LOGIN PASSWORD '${secret()}'`);
      expect(await lookup(plain)).toHaveLength(1);

      const owner = await admin.query<{ owner: string; me: string }>(
        `SELECT pg_get_userbyid(relowner)::text AS owner, session_user::text AS me
           FROM pg_class WHERE oid = to_regclass('_prisma_migrations')`,
      );
      const superuser = probeRole("super");
      const ownerMember = probeRole("owner");
      const replication = probeRole("repl");
      const expired = probeRole("expired");
      const noLogin = probeRole("nologin");
      const md5 = probeRole("md5");

      await admin.query(
        `CREATE ROLE ${superuser} SUPERUSER LOGIN PASSWORD '${secret()}'`,
      );
      await admin.query(
        `CREATE ROLE ${ownerMember} LOGIN PASSWORD '${secret()}'`,
      );
      await admin.query(`GRANT "${owner.rows[0].owner}" TO ${ownerMember}`);
      await admin.query(
        `CREATE ROLE ${replication} REPLICATION LOGIN PASSWORD '${secret()}'`,
      );
      await admin.query(
        `CREATE ROLE ${expired} LOGIN PASSWORD '${secret()}' VALID UNTIL '2000-01-01'`,
      );
      await admin.query(
        `CREATE ROLE ${noLogin} NOLOGIN PASSWORD '${secret()}'`,
      );
      await admin.query(`ALTER ROLE ${AUTH_ROLE} LOGIN PASSWORD '${secret()}'`);

      // The standby's login (F4-40), refused by name even without the
      // REPLICATION attribute.
      const standby = await admin.query(
        `SELECT 1 FROM pg_roles WHERE rolname = 'trajetto_replication'`,
      );

      await admin.query(
        standby.rowCount
          ? `ALTER ROLE trajetto_replication NOREPLICATION LOGIN PASSWORD '${secret()}'`
          : `CREATE ROLE trajetto_replication LOGIN PASSWORD '${secret()}'`,
      );

      // A verifier that is not SCRAM: PgBouncer could not use it, and
      // Postgres would refuse it under scram-sha-256 anyway.
      await admin.query("SET LOCAL password_encryption = 'md5'");
      await admin.query(`CREATE ROLE ${md5} LOGIN PASSWORD '${secret()}'`);

      for (const name of [
        owner.rows[0].owner,
        owner.rows[0].me,
        superuser,
        ownerMember,
        replication,
        "trajetto_replication",
        AUTH_ROLE,
        expired,
        noLogin,
        md5,
        probeRole("nobody"),
      ]) {
        expect(await lookup(name), name).toEqual([]);
      }
    });
  });

  it("refuses the lookup to every runtime role (42501), even one given USAGE on the schema", async () => {
    const call = `SELECT * FROM ${LOOKUP}('trajetto_http')`;

    for (const role of [
      "trajetto_http",
      "trajetto_worker",
      "trajetto_batch",
      "trajetto_read",
      "trajetto_app",
    ]) {
      expect(await codeAs(role, call), role).toBe("42501");
    }

    // The function's own REVOKE, not only the schema's: without it, PUBLIC
    // keeps EXECUTE and this call reads the verifier.
    expect(
      await codeAs(
        "trajetto_http",
        call,
        "GRANT USAGE ON SCHEMA pgbouncer TO trajetto_http",
      ),
    ).toBe("42501");
  });

  it("reads the catalog's pg_authid, never a temporary table of the caller's", async () => {
    const fake = probeRole("fake");

    await rolledBack(async () => {
      await admin.query(`SET LOCAL ROLE ${AUTH_ROLE}`);
      await admin.query(
        `CREATE TEMP TABLE pg_authid (
           oid oid, rolname name, rolpassword text, rolcanlogin boolean,
           rolsuper boolean, rolreplication boolean, rolvaliduntil timestamptz
         );
         INSERT INTO pg_authid
           VALUES (0, '${fake}', 'SCRAM-SHA-256$4096:fake', true, false, false, NULL);`,
      );
      await admin.query("RESET ROLE");

      expect(await lookup(fake)).toEqual([]);
    });
  });

  it("is pending, and changes nothing, for a user that is not a superuser", async () => {
    const sql = readFileSync(resolve(process.cwd(), STEP), "utf8");
    const notices: string[] = [];
    const onNotice = (notice: { message?: string }) =>
      notices.push(notice.message ?? "");

    admin.on("notice", onNotice);

    try {
      await rolledBack(async () => {
        await admin.query("DROP SCHEMA pgbouncer CASCADE");
        await admin.query("SET LOCAL ROLE trajetto_batch");
        await admin.query(sql);
        await admin.query("RESET ROLE");

        expect(notices[notices.length - 1]).toMatch(/^pending: /);
        expect(await state()).toBeNull();
      });
    } finally {
      admin.off("notice", onNotice);
    }
  });

  it("converges again: grants made by hand are taken back, a rewritten lookup is restored", async () => {
    // A grant passed on by a grantee is DDL the untrusted-code trigger
    // refuses: off for the plant only, to see the CASCADE take it back.
    await admin.query(
      `GRANT EXECUTE ON FUNCTION ${LOOKUP}(text) TO PUBLIC;
       GRANT EXECUTE ON FUNCTION ${LOOKUP}(text) TO ${AUTH_ROLE} WITH GRANT OPTION;
       GRANT USAGE, CREATE ON SCHEMA pgbouncer TO trajetto_batch;
       ALTER EVENT TRIGGER trajetto_untrusted_code DISABLE;
       SET ROLE ${AUTH_ROLE};
       GRANT EXECUTE ON FUNCTION ${LOOKUP}(text) TO trajetto_read;
       RESET ROLE;
       ALTER EVENT TRIGGER trajetto_untrusted_code ENABLE;`,
    );

    expect((await state())?.functionGrants).toContain("trajetto_read=EXECUTE");
    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await state()).toEqual(CLOSED);

    // The same shape, but every verifier, without the pinned search_path.
    await admin.query(
      `CREATE OR REPLACE FUNCTION ${LOOKUP}(i_username text)
         RETURNS TABLE(usename name, passwd text)
         LANGUAGE sql SECURITY DEFINER
         AS $f$ SELECT rolname, rolpassword FROM pg_authid WHERE rolname = i_username $f$`,
    );

    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await state()).toEqual(CLOSED);

    // Another shape, which a replace cannot fix.
    await admin.query(
      `DROP FUNCTION ${LOOKUP}(text);
       CREATE FUNCTION ${LOOKUP}(who text) RETURNS SETOF text
         LANGUAGE sql AS $f$ SELECT rolpassword FROM pg_authid WHERE rolname = who $f$;`,
    );

    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await state()).toEqual(CLOSED);

    await rolledBack(async () => {
      const superuser = probeRole("super");

      await admin.query(
        `CREATE ROLE ${superuser} SUPERUSER LOGIN PASSWORD '${secret()}'`,
      );
      expect(await lookup(superuser)).toEqual([]);
    });

    expect(await runStep()).toMatchObject({ status: "skipped" });
  });

  it("takes the schema and the lookup back from a role that made them first, and drops an overload", async () => {
    const database = (
      await admin.query<{ name: string }>("SELECT current_database() AS name")
    ).rows[0].name;

    // As an attacker who got there before the step: the schema, the lookup
    // and an overload, all owned by the role, which could rewrite them later
    // (the untrusted-code trigger is off for the plant only).
    await admin.query(
      `DROP SCHEMA pgbouncer CASCADE;
       ALTER EVENT TRIGGER trajetto_untrusted_code DISABLE;
       GRANT CREATE ON DATABASE "${database}" TO trajetto_read;`,
    );

    try {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE trajetto_read");
      await admin.query(
        `CREATE SCHEMA pgbouncer;
         CREATE FUNCTION ${LOOKUP}(i_username text)
           RETURNS TABLE(usename name, passwd text)
           LANGUAGE sql AS $f$ SELECT NULL::name, NULL::text $f$;
         CREATE FUNCTION ${LOOKUP}(i_username name)
           RETURNS TABLE(usename name, passwd text)
           LANGUAGE sql AS $f$ SELECT NULL::name, NULL::text $f$;`,
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    } finally {
      await admin.query(
        `REVOKE CREATE ON DATABASE "${database}" FROM trajetto_read;
         ALTER EVENT TRIGGER trajetto_untrusted_code ENABLE;`,
      );
    }

    expect(await state()).toMatchObject({
      ownerIsSuperuser: false,
      schemaOwnerIsSuperuser: false,
      sameName: 2,
    });
    expect(await runStep()).toMatchObject({ status: "applied" });
    expect(await state()).toEqual(CLOSED);
    expect(await runStep()).toMatchObject({ status: "skipped" });
  });
});
