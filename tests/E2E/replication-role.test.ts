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
 * The standby's role (infra/sql/40-replication.sql; plano-escala F4-40 and
 * its security review).
 *
 * trajetto_replication clones the whole cluster and follows its WAL: a
 * base backup is every byte of it, verifiers included. So the release step
 * keeps it NOLOGIN with REPLICATION and nothing else (no SUPERUSER,
 * CREATEDB, CREATEROLE, BYPASSRLS, no membership that would hand it the
 * tables over an ordinary connection), and never gives a power nor a
 * login: those are the owner's, by hand, when there is a standby.
 *
 * Run as the release step runs it: the real file, through the real runner
 * where nothing changes, and by hand inside a transaction rolled back
 * where it must change something. The role is the cluster's, so every
 * change to it stays inside a transaction that is rolled back.
 */
const URL = () => process.env.DATABASE_URL as string;
const STEP = "infra/sql/40-replication.sql";
const ROLE = "trajetto_replication";
const SQL = () => readFileSync(resolve(process.cwd(), STEP), "utf8");

let admin: pg.Client;
let notices: string[] = [];

async function runStep() {
  const step = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === STEP,
  );

  if (!step) throw new Error(`${STEP} não foi encontrado`);

  const client = await openReleaseClient(URL(), "e2e-replication-role");

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

/** The file run on `admin`'s open transaction; the last NOTICE it raised. */
async function runInTransaction(): Promise<string> {
  notices = [];
  await admin.query(SQL());

  return notices[notices.length - 1] ?? "";
}

/** The role's attributes and memberships, as the catalog has them. */
async function role() {
  const { rows } = await admin.query<{
    login: boolean;
    replication: boolean;
    superuser: boolean;
    createdb: boolean;
    createrole: boolean;
    bypassrls: boolean;
    memberOf: string[];
  }>(
    `SELECT r.rolcanlogin AS login, r.rolreplication AS replication,
            r.rolsuper AS superuser, r.rolcreatedb AS createdb,
            r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls,
            ARRAY(
              SELECT m.roleid::regrole::text FROM pg_auth_members m
               WHERE m.member = r.oid ORDER BY 1
            ) AS "memberOf"
       FROM pg_roles r WHERE r.rolname = $1`,
    [ROLE],
  );

  return rows[0] ?? null;
}

const CLOSED = {
  replication: true,
  superuser: false,
  createdb: false,
  createrole: false,
  bypassrls: false,
  memberOf: [],
};

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-replication-role-admin");
  admin.on("notice", (notice) => notices.push(notice.message ?? ""));
});

afterAll(async () => {
  await admin.end();
});

describe("infra/sql/40-replication.sql", () => {
  it("left the template with the role NOLOGIN, with REPLICATION and nothing else, and changes nothing the second time", async () => {
    // NOLOGIN until the owner gives it a login: the release step never
    // does, and in the shared test cluster nobody did.
    expect(await role()).toEqual({ ...CLOSED, login: false });
    expect(await runStep()).toMatchObject({ step: STEP, status: "skipped" });
  });

  it("creates the role NOLOGIN with REPLICATION when it is missing", async () => {
    await rolledBack(async () => {
      await admin.query(`DROP ROLE ${ROLE}`);
      expect(await role()).toBeNull();

      expect(await runInTransaction()).toMatch(
        /^applied: role trajetto_replication criado \(NOLOGIN, com REPLICATION/,
      );
      expect(await role()).toEqual({ ...CLOSED, login: false });
    });
  });

  it("takes away every other power and membership, whoever granted it, and keeps the owner's login", async () => {
    const granter = `wfl_repl_granter_${randomBytes(4).toString("hex")}`;

    await rolledBack(async () => {
      // The owner's hand step, then what nobody should have given it.
      await admin.query(
        `ALTER ROLE ${ROLE} LOGIN PASSWORD '${randomBytes(18).toString("hex")}'`,
      );
      await admin.query(
        `ALTER ROLE ${ROLE} SUPERUSER CREATEDB CREATEROLE BYPASSRLS`,
      );
      await admin.query("GRANT trajetto_app TO trajetto_replication");
      // A second grant of a membership, by a role with ADMIN on it: a
      // REVOKE without GRANTED BY would leave this one.
      await admin.query(`CREATE ROLE ${granter} NOLOGIN`);
      await admin.query(`GRANT pg_monitor TO ${granter} WITH ADMIN OPTION`);
      await admin.query(`SET LOCAL ROLE ${granter}`);
      await admin.query("GRANT pg_monitor TO trajetto_replication");
      await admin.query("RESET ROLE");

      expect((await role())?.memberOf).toEqual(["pg_monitor", "trajetto_app"]);

      const notice = await runInTransaction();

      expect(notice).toMatch(/^applied: role trajetto_replication: /);
      expect(notice).toContain("NOSUPERUSER");
      expect(notice).toContain("membro de trajetto_app");
      expect(notice).toContain(`membro de pg_monitor (por ${granter})`);
      expect(await role()).toEqual({ ...CLOSED, login: true });

      notices = [];
      expect(await runInTransaction()).toMatch(/^skipped: /);
    });
  });

  it("never gives REPLICATION back: a role without it is reported and left as it is", async () => {
    await rolledBack(async () => {
      await admin.query(`ALTER ROLE ${ROLE} NOREPLICATION`);

      expect(await runInTransaction()).toMatch(
        /^skipped: role trajetto_replication: sem o atributo de replicação/,
      );
      expect((await role())?.replication).toBe(false);
    });
  });

  it("is pending, and changes nothing, for a user that is not a superuser", async () => {
    const plain = `wfl_repl_plain_${randomBytes(4).toString("hex")}`;

    await rolledBack(async () => {
      await admin.query(`ALTER ROLE ${ROLE} CREATEDB`);
      await admin.query(`CREATE ROLE ${plain} NOLOGIN`);
      await admin.query(`SET LOCAL ROLE ${plain}`);

      expect(await runInTransaction()).toMatch(
        new RegExp(`^pending: o usuário ${plain} não é superusuário`),
      );

      await admin.query("RESET ROLE");
      expect((await role())?.createdb).toBe(true);
    });
  });
});
