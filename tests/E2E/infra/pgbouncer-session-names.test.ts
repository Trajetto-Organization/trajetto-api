// @vitest-environment node
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

import { infraUrl } from "./support/infra-urls";

/**
 * The sessions PgBouncer opens on the database carry a name (the
 * adoption of the wave 17, plano-escala F4-39).
 *
 * The release step's trajetto_capability_ready
 * (prisma/post-deploy/00-queue-swap-ready.sql) reads an unnamed client
 * session in the database as the image from before the scale plan, and
 * holds every contraction back while one is connected. PgBouncer opens
 * its own session as pgbouncer_auth to run the auth_query, and sends no
 * application_name for it: measured on this stack before the fix, it was
 * the one unnamed session, there for as long as PgBouncer runs.
 * infra/sql/30-pgbouncer-auth.sql names it by a default of the role. And a
 * runtime client's name reaches the server connection of its
 * transactions, so the API's sessions through the pool stay named too.
 */
const POOLED = infraUrl("pgbouncer");
const PRIMARY = infraUrl("primary");

const opened: pg.Client[] = [];

afterAll(async () => {
  await Promise.all(opened.map((client) => client.end().catch(() => {})));
});

async function connect(url: string, applicationName?: string) {
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
  });

  client.on("error", () => {});
  await client.connect();
  opened.push(client);

  return client;
}

describe("the sessions PgBouncer opens on the database", () => {
  it("are named: its auth session by the role's default, the API's by the pool's own name", async () => {
    // A login through the pool runs the auth_query, on pgbouncer_auth's
    // session, and a transaction of the API's client on a server one.
    const api = createPrismaClient(
      {},
      { url: `${POOLED}?pgbouncer=true&connection_limit=1` },
    );

    try {
      await api.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      });

      const primary = await connect(PRIMARY, "e2e-infra-session-names");
      const { rows } = await primary.query<{
        usename: string;
        application_name: string;
      }>(
        `SELECT usename, application_name
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'
            AND usename IN ('pgbouncer_auth', 'trajetto_http')`,
      );

      const auth = rows.filter((row) => row.usename === "pgbouncer_auth");

      expect(auth.length).toBeGreaterThanOrEqual(1);
      expect(new Set(auth.map((row) => row.application_name))).toEqual(
        new Set(["trajetto-pgbouncer-auth"]),
      );

      // The API's transaction left its pool's name on the server
      // connection (pg-driver.ts's default for a client with no role).
      expect(
        rows.some(
          (row) =>
            row.usename === "trajetto_http" &&
            row.application_name === "trajetto-api",
        ),
      ).toBe(true);
    } finally {
      await api.$disconnect();
    }
  });
});
