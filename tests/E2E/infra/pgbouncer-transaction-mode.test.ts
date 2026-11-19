// @vitest-environment node
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

import { infraUrl } from "./support/infra-urls";

/**
 * The real PgBouncer (the trajetto-pgbouncer image, infra/pgbouncer) in
 * front of a real primary, in the E2E infra phase (plano-escala F4-38;
 * tests/E2E/infra/run.sh starts both).
 *
 * What the runtime assumes when its URLs point at the pool (wave 17): the
 * login is SCRAM through the auth_query, with no application password in
 * PgBouncer; the role's own ceilings apply, since a pooled connection
 * carries no `options`; the owner never gets in; a server connection is
 * handed back at the end of every transaction, so a session SET outlives
 * its client and reaches the next one (what pgbouncer-compat.test.ts keeps
 * out of src/), and SET LOCAL does not; and the API's own client runs its
 * queries and interactive transactions through it.
 *
 * Which server connection a client gets is the measurement here: PgBouncer
 * hands out the idle one used last (server_round_robin=0, its default), and
 * the infra phase runs one file at a time, so no other client takes it in
 * between.
 */
const POOLED = infraUrl("pgbouncer");
const STATS = infraUrl("pgbouncerStats");
const PRIMARY = infraUrl("primary");

const opened: pg.Client[] = [];

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();
  opened.push(client);

  return client;
}

/** The backend (server connection) that ran this statement. */
async function backendOf(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );

  return rows[0].pid;
}

async function settingOf(client: pg.Client, name: string) {
  const { rows } = await client.query<{ pid: number; value: string }>(
    "SELECT pg_backend_pid() AS pid, current_setting($1) AS value",
    [name],
  );

  return rows[0];
}

/** `base` with the login of `from` (same host, port and database). */
function withLogin(base: string, from: string): string {
  const url = new URL(base);
  const login = new URL(from);

  url.username = login.username;
  url.password = login.password;

  return url.toString();
}

/**
 * trajetto_http straight on the primary, without the pool: a login gets the
 * role's own settings (ALTER ROLE … SET, infra/sql/20-runtime-roles.sql),
 * the ceilings a pooled connection must keep.
 */
let direct: pg.Client;

async function directSetting(name: string): Promise<string> {
  return (await settingOf(direct, name)).value;
}

beforeAll(async () => {
  direct = new pg.Client({ connectionString: withLogin(PRIMARY, POOLED) });
  await direct.connect();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.end()));
});

afterAll(async () => {
  await direct.end();
});

describe("the PgBouncer of the infra phase", () => {
  it("pools by transaction, as the image configures it", async () => {
    const stats = await connect(STATS);
    const { rows } = await stats.query<{ key: string; value: string }>(
      "SHOW CONFIG",
    );
    const config = new Map(rows.map((row) => [row.key, row.value]));

    expect(config.get("pool_mode")).toBe("transaction");
    expect(config.get("auth_query")).toBe(
      "SELECT * FROM pgbouncer.user_lookup($1)",
    );
  });

  it("logs the runtime in by the verifier the database holds, with the role's own ceilings", async () => {
    const client = await connect(POOLED);
    const { rows } = await client.query<{
      user: string;
      statement: string;
      idle: string;
    }>(
      `SELECT current_user AS user,
              current_setting('statement_timeout') AS statement,
              current_setting('idle_in_transaction_session_timeout') AS idle`,
    );

    expect(rows[0].user).toBe("trajetto_http");
    // No `options` through the pool: these come from the role (F3-19).
    expect(rows[0].statement).toBe(await directSetting("statement_timeout"));
    expect(rows[0].idle).toBe(
      await directSetting("idle_in_transaction_session_timeout"),
    );
    expect(rows[0].statement).not.toBe("0");
  });

  it("refuses a wrong password and the owner of the tables", async () => {
    const mistyped = new URL(POOLED);

    mistyped.password = "not-the-password-0000";

    const wrong = new pg.Client({ connectionString: mistyped.toString() });
    const superuser = new pg.Client({
      connectionString: withLogin(POOLED, PRIMARY),
    });

    await expect(wrong.connect()).rejects.toThrow(
      /^SASL authentication failed$/,
    );
    // The superuser's password is right; pgbouncer.user_lookup returns no
    // row for it, so PgBouncer has nothing to check it against.
    await expect(superuser.connect()).rejects.toThrow(/^no such user$/);
  });

  it("hands the server connection back at the end of every transaction", async () => {
    const first = await connect(POOLED);
    const second = await connect(POOLED);

    // Both clients stay connected; in session mode the second one could
    // never get the first one's server connection.
    const used = await backendOf(first);

    expect(await backendOf(second)).toBe(used);

    // Inside a transaction the server connection is the client's alone.
    await first.query("BEGIN");
    const held = await backendOf(first);

    expect(await backendOf(second)).not.toBe(held);
    expect(await backendOf(first)).toBe(held);
    await first.query("COMMIT");
  });

  it("lets a session SET reach the next client, and keeps a SET LOCAL to its transaction", async () => {
    const first = await connect(POOLED);
    const second = await connect(POOLED);
    const ceiling = await directSetting("statement_timeout");

    await first.query("SET statement_timeout = '4321ms'");
    const changed = await backendOf(first);

    try {
      const leaked = await settingOf(second, "statement_timeout");

      // Another client, the same server connection, the first one's SET.
      expect(leaked.pid).toBe(changed);
      expect(leaked.value).toBe("4321ms");
    } finally {
      // The second client ran last, so it holds that connection next.
      await second.query("RESET statement_timeout");
    }

    expect((await settingOf(first, "statement_timeout")).value).toBe(ceiling);

    await first.query("BEGIN");
    await first.query("SET LOCAL statement_timeout = '4321ms'");
    const local = await settingOf(first, "statement_timeout");
    await first.query("COMMIT");

    const after = await settingOf(second, "statement_timeout");

    expect(local.value).toBe("4321ms");
    expect(after.pid).toBe(local.pid);
    expect(after.value).toBe(ceiling);
  });

  it("serves the API's own client: queries and an interactive transaction", async () => {
    const prisma = createPrismaClient(undefined, { url: POOLED });

    try {
      const [who] = await prisma.$queryRaw<Array<{ user: string }>>`
        SELECT current_user AS user`;

      expect(who.user).toBe("trajetto_http");

      const backends = await prisma.$transaction(async (tx) => {
        const one = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid`;
        const two = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid`;

        return [one[0].pid, two[0].pid];
      });

      // One transaction, one server connection, from BEGIN to COMMIT.
      expect(backends[1]).toBe(backends[0]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
