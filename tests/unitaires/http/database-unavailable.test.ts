import { Prisma } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import {
  DATABASE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailable,
} from "@/shared/errors/database-unavailable";

/**
 * What the API answers when the database, not the request, is the problem.
 *
 * Failure injection with real Prisma 6.1 errors (a client that could not
 * start, a refused reconnect, a connection Postgres closed, a saturated pool)
 * showed every one of them leaving the global handler as
 * `500 INTERNAL_ERROR` with no Retry-After. Login, refresh, 2FA, /public/track
 * and the public integration API all answered 500 while the authenticated
 * routes answered 503 — the same outage, two semantics. A generic HTTP client
 * does not repeat a POST that got a 500, and the logs could not tell a
 * database that is down from a bug.
 *
 * No database: every route below throws before touching one.
 */
const clientVersion = Prisma.prismaVersion.client;

const known = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion });

/**
 * A `$queryRaw`/`$executeRaw` failure, as Prisma 6.1 raises it: P2010, with
 * Postgres' SQLSTATE and message in `meta` — or `N/A` where there was none.
 * Shapes measured against the real engine (GAP6-4): the dead-peer timeout is
 * `N/A`/`N/A`; a column it cannot decode is `N/A` with its own message.
 */
const rawFailure = (sqlState: string, detail: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`${sqlState}\`. Message: \`${detail}\``,
    { code: "P2010", clientVersion, meta: { code: sqlState, message: detail } },
  );

const infrastructure: Record<string, () => Error> = {
  initialization: () =>
    new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `localhost:5432`",
      clientVersion,
      "P1001",
    ),
  unreachable: () =>
    known("P1001", "Can't reach database server at `localhost:5432`"),
  "timed-out": () =>
    known("P1002", "The database server was reached but timed out."),
  "operation-timeout": () => known("P1008", "Operations timed out after 10s"),
  closed: () => known("P1017", "Server has closed the connection."),
  "pool-exhausted": () =>
    known(
      "P2024",
      "Timed out fetching a new connection from the connection pool.",
    ),
  "too-many-connections": () =>
    known("P2037", "Too many database connections opened"),
  "transaction-start": () =>
    known(
      "P2028",
      "Transaction API error: Unable to start a transaction in the given time.",
    ),
  // A raw query past socket_timeout: Postgres never answered, so there is no
  // SQLSTATE and no message — only the engine's `N/A`.
  "raw-query-timed-out": () => rawFailure("N/A", "N/A"),
};

const notInfrastructure: Record<string, () => Error> = {
  unique: () =>
    known("P2002", "Unique constraint failed on the fields: (`cnpj`)"),
  "not-found": () => known("P2025", "Record to update not found."),
  "transaction-closed": () =>
    known(
      "P2028",
      "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction.",
    ),
  // Raw queries Postgres answered: SQLSTATEs are answers about the SQL, the
  // statement_timeout (57014) included — a live server that cancelled it.
  "raw-sql-error": () =>
    rawFailure(
      "42P01",
      'ERROR: relation "gap6_4_no_such_table" does not exist',
    ),
  "raw-statement-timeout": () =>
    rawFailure("57014", "ERROR: canceling statement due to statement timeout"),
  // No SQLSTATE either, but the engine says what went wrong: our query.
  "raw-undecodable-column": () =>
    rawFailure(
      "N/A",
      "Failed to deserialize column of type 'void'. If you're using $queryRaw and this column is explicitly marked as `Unsupported` in your Prisma schema, try casting this column to any supported Prisma type such as `String`.",
    ),
  bug: () =>
    new TypeError("Cannot read properties of undefined (reading 'role')"),
  // Only the message says "database": nothing proves it came from Prisma.
  "plain-error": () => new Error("Can't reach database server"),
};

describe("isDatabaseUnavailable", () => {
  for (const [name, build] of Object.entries(infrastructure)) {
    it(`is true for ${name}`, () => {
      expect(isDatabaseUnavailable(build())).toBe(true);
    });
  }

  for (const [name, build] of Object.entries(notInfrastructure)) {
    it(`is false for ${name}`, () => {
      expect(isDatabaseUnavailable(build())).toBe(false);
    });
  }

  it("is false for things that are not errors", () => {
    expect(isDatabaseUnavailable(undefined)).toBe(false);
    expect(isDatabaseUnavailable("P1001")).toBe(false);
    expect(isDatabaseUnavailable({ code: "P1001" })).toBe(false);
  });
});

type App = Awaited<typeof import("@/http")>["app"];

let app: App;

beforeAll(async () => {
  ({ app } = await import("@/http"));

  const all = { ...infrastructure, ...notInfrastructure };

  // Registered before `ready()`, so the routes go through the real hooks and
  // the real error handler.
  app.get<{ Params: { kind: string } }>(
    "/__test/database-failure/:kind",
    { config: { rateLimit: false } },
    async (request) => {
      throw all[request.params.kind]();
    },
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const call = (kind: string) =>
  app.inject({ method: "GET", url: `/__test/database-failure/${kind}` });

describe("the global error handler", () => {
  for (const kind of Object.keys(infrastructure)) {
    it(`answers 503 with Retry-After when the database is ${kind}`, async () => {
      const response = await call(kind);

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe(
        String(DATABASE_RETRY_AFTER_SECONDS),
      );

      // Serializers of generated clients drop `code` from the body; the
      // header survives them.
      expect(response.headers["x-error-code"]).toBe("SERVICE_UNAVAILABLE");
      expect(response.json().code).toBe("SERVICE_UNAVAILABLE");

      // Nothing about the connection string or the engine reaches the body.
      expect(response.body).not.toMatch(/localhost|P1|P2|prisma/i);
    });
  }

  for (const kind of [
    "bug",
    "unique",
    "not-found",
    "plain-error",
    "raw-sql-error",
    "raw-statement-timeout",
    "raw-undecodable-column",
  ]) {
    it(`still answers 500 without Retry-After for ${kind}`, async () => {
      const response = await call(kind);

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.headers["retry-after"]).toBeUndefined();
    });
  }
});
