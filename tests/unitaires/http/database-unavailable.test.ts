import net from "node:net";

import { Prisma } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import { closedPort, systemError } from "../../support/fake-postgres";
import { commitWriteConflict } from "../../support/serialization-failure";

import {
  DATABASE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailable,
} from "@/shared/errors/database-unavailable";
import { createPrismaClient } from "@/shared/database/database-client";
import { typedDriverError } from "@/shared/database/pg-driver";

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

/**
 * A failure as Prisma 7 raises it: the driver adapter's error rides in
 * `meta.driverAdapterError`, its `cause` saying what happened. P2010 for a
 * raw query, P2039 for a model query Postgres refused. Shapes measured with
 * @prisma/client 7.10.1 + @prisma/adapter-pg 7.10.1 against Postgres 16.
 */
const driverFailure = (
  code: "P2010" | "P2039",
  cause: Record<string, unknown>,
) =>
  new Prisma.PrismaClientKnownRequestError(
    code === "P2010" ? "Raw query failed." : "Database error.",
    {
      code,
      clientVersion,
      meta: {
        driverAdapterError: Object.assign(new Error("driver adapter error"), {
          name: "DriverAdapterError",
          cause,
        }),
      },
    },
  );

/**
 * What a failed COMMIT of an interactive `$transaction` throws under Prisma
 * 7: the driver adapter's own error, with no Prisma class around it, its
 * `cause` built by adapter-pg. Shapes measured with @prisma/client 7.10.1 +
 * @prisma/adapter-pg 7.10.1 against Postgres 16
 * (tests/E2E/commit-database-unavailable-http.test.ts).
 */
const commitFailure = (cause: Record<string, unknown>) =>
  Object.assign(new Error(String(cause.kind)), {
    name: "DriverAdapterError",
    cause,
  });

/** adapter-pg's cause for a SQLSTATE it has no kind of its own for. */
const postgresCause = (code: string, message: string) => ({
  kind: "postgres",
  originalCode: code,
  originalMessage: message,
  code,
  severity: "FATAL",
  message,
});

/** pg's own error, as the API's pool types it (src/shared/database/pg-driver.ts). */
const fromPool = (message: string) =>
  typedDriverError(new Error(message)) as Error;

/** A socket errno as Node raises it, as the API's pool types it. */
const socketFromPool = (code: string, syscall: string, target?: string) =>
  typedDriverError(systemError(code, syscall, target)) as Error;

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
  // Prisma 7: pg's pool and sockets, typed by the API's pool.
  "pg-pool-exhausted": () =>
    fromPool("timeout exceeded when trying to connect"),
  "pg-read-timeout": () => fromPool("Query read timeout"),
  "pg-connection-terminated": () =>
    fromPool("Connection terminated unexpectedly"),
  "pg-connect-timeout": () =>
    fromPool("Connection terminated due to connection timeout"),
  // Prisma 7: socket errnos the adapter does not map, typed by the pool.
  "pg-host-unreachable": () =>
    socketFromPool("EHOSTUNREACH", "connect", "10.0.0.9:5432"),
  "pg-network-unreachable": () =>
    socketFromPool("ENETUNREACH", "connect", "240.0.0.1:5432"),
  "pg-dns-try-again": () =>
    socketFromPool("EAI_AGAIN", "getaddrinfo", "db.internal"),
  "pg-broken-pipe": () => socketFromPool("EPIPE", "write"),
  // Prisma 7: the same errno reaching Prisma untyped becomes the code.
  "v7-untyped-errno": () =>
    known("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.9:5432"),
  // Prisma 7: a raw query gets every adapter error as P2010.
  "v7-raw-unreachable": () =>
    driverFailure("P2010", {
      kind: "DatabaseNotReachable",
      host: "127.0.0.1",
      port: 5432,
    }),
  "v7-raw-connection-closed": () =>
    driverFailure("P2010", { kind: "ConnectionClosed" }),
  // Postgres going away under a query: the server is shutting down.
  "v7-raw-admin-shutdown": () =>
    driverFailure("P2010", {
      kind: "postgres",
      originalCode: "57P01",
      code: "57P01",
      originalMessage: "terminating connection due to administrator command",
    }),
  "v7-model-admin-shutdown": () =>
    driverFailure("P2039", {
      kind: "postgres",
      originalCode: "57P01",
      code: "57P01",
      originalMessage: "terminating connection due to administrator command",
    }),
  // Prisma 7: a failed COMMIT, the adapter's error bare. The backend running
  // it was terminated (a restart, a failover): Prisma 6 said P1017.
  "v7-commit-admin-shutdown": () =>
    commitFailure(
      postgresCause(
        "57P01",
        "terminating connection due to administrator command",
      ),
    ),
  // The connection reset after the COMMIT ran: it may have landed, and it is
  // still a 503 (P1017 in Prisma 6), never a 500.
  "v7-commit-connection-closed": () =>
    commitFailure({ kind: "ConnectionClosed" }),
  "v7-commit-unreachable": () =>
    commitFailure({
      kind: "DatabaseNotReachable",
      host: "127.0.0.1",
      port: 5432,
    }),
  "v7-commit-socket-timeout": () => commitFailure({ kind: "SocketTimeout" }),
  "v7-commit-too-many-connections": () =>
    commitFailure({
      kind: "TooManyConnections",
      originalCode: "53300",
      originalMessage: "sorry, too many clients already",
      cause: "sorry, too many clients already",
    }),
  "v7-commit-crash-shutdown": () =>
    commitFailure(
      postgresCause(
        "57P02",
        "terminating connection because of crash of another server process",
      ),
    ),
  "v7-commit-connection-failure": () =>
    commitFailure(postgresCause("08006", "connection failure")),
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
  // pg's exact words, but not from the API's pool: still untrusted.
  "plain-error-with-pg-words": () =>
    new Error("timeout exceeded when trying to connect"),
  // A socket errno from anything else (the mail provider): not the database.
  "plain-socket-errno": () =>
    systemError("EHOSTUNREACH", "connect", "10.0.0.9:587"),
  // Prisma 7: Postgres answered, about the SQL.
  "v7-raw-sql-error": () =>
    driverFailure("P2010", {
      kind: "TableDoesNotExist",
      originalCode: "42P01",
      originalMessage: 'relation "gap6_4_no_such_table" does not exist',
      table: "gap6_4_no_such_table",
    }),
  "v7-raw-statement-timeout": () =>
    driverFailure("P2010", {
      kind: "postgres",
      originalCode: "57014",
      code: "57014",
      originalMessage: "canceling statement due to statement timeout",
    }),
  "v7-model-statement-timeout": () =>
    driverFailure("P2039", {
      kind: "postgres",
      originalCode: "57014",
      code: "57014",
      originalMessage: "canceling statement due to statement timeout",
    }),
  "v7-unique": () =>
    driverFailure("P2039", {
      kind: "UniqueConstraintViolation",
      originalCode: "23505",
      constraint: { index: "driver_businessId_cpf_key" },
    }),
  // Prisma 7: answers about the data at COMMIT, the adapter's error bare. A
  // serialization conflict is the retry loops' business, not an outage.
  "v7-commit-write-conflict": () => commitWriteConflict(),
  "v7-commit-deadlock": () => commitWriteConflict("40P01"),
  // A deferred unique constraint is checked at COMMIT.
  "v7-commit-unique": () =>
    commitFailure({
      kind: "UniqueConstraintViolation",
      originalCode: "23505",
      originalMessage:
        'duplicate key value violates unique constraint "driver_businessId_cpf_key"',
      constraint: { index: "driver_businessId_cpf_key" },
    }),
  // A deferred trigger past the statement_timeout: a live server cancelled it.
  "v7-commit-statement-timeout": () =>
    commitFailure({
      ...postgresCause("57014", "canceling statement due to statement timeout"),
      severity: "ERROR",
    }),
  // The adapter's cause, but not under the adapter's name: untrusted.
  "v7-commit-lookalike": () =>
    Object.assign(new Error("ConnectionClosed"), {
      cause: { kind: "ConnectionClosed" },
    }),
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
    // The adapter's name and cause on a plain object: no class, no trust.
    expect(
      isDatabaseUnavailable({
        name: "DriverAdapterError",
        cause: { kind: "ConnectionClosed" },
      }),
    ).toBe(false);
  });
});

type App = Awaited<typeof import("@/http")>["app"];

let app: App;

/**
 * For the end-to-end case below: connecting to this port fails as the OS
 * fails a connect, with the errno the request names. Everything above the
 * socket is real — pg, pg-pool, the API's pool, the adapter, Prisma and the
 * error handler.
 */
let unreachablePort = 0;
let failConnectWith: () => NodeJS.ErrnoException;

const realConnect = net.Socket.prototype.connect;

/** Where each errno comes from when a connection is being opened. */
const CONNECT_ERRNOS: Record<string, [syscall: string, target: string]> = {
  EHOSTUNREACH: ["connect", "10.0.0.9:5432"],
  ENETUNREACH: ["connect", "240.0.0.1:5432"],
  EADDRNOTAVAIL: ["connect", "255.255.255.255:5432"],
  ECONNABORTED: ["connect", "10.0.0.9:5432"],
  EAI_AGAIN: ["getaddrinfo", "db.internal"],
};

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

  unreachablePort = await closedPort();

  net.Socket.prototype.connect = function connect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const [first] = args as [{ port?: unknown } | number | string];
    const port = typeof first === "object" ? first.port : first;

    if (Number(port) !== unreachablePort) {
      return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }

    // As Node reports a failed connect: the socket is destroyed with it.
    process.nextTick(() => this.destroy(failConnectWith()));

    return this;
  } as typeof realConnect;

  app.get<{ Params: { query: string; errno: string } }>(
    "/__test/database-route/:query/:errno",
    { config: { rateLimit: false } },
    async (request) => {
      const { query, errno } = request.params;
      const [syscall, target] = CONNECT_ERRNOS[errno];

      failConnectWith = () => systemError(errno, syscall, target);

      const client = createPrismaClient(
        { log: [] },
        { url: `postgresql://u:p@127.0.0.1:${unreachablePort}/d` },
      );

      try {
        return query === "raw"
          ? await client.$queryRaw`SELECT 1`
          : await client.user.count();
      } finally {
        await client.$disconnect();
      }
    },
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  net.Socket.prototype.connect = realConnect;

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
    "v7-commit-write-conflict",
    "v7-commit-unique",
  ]) {
    it(`still answers 500 without Retry-After for ${kind}`, async () => {
      const response = await call(kind);

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.headers["retry-after"]).toBeUndefined();
    });
  }
});

/**
 * A database host the network cannot reach, end to end. The adapter maps
 * only ENOTFOUND/ECONNREFUSED/ECONNRESET/ETIMEDOUT; any other errno reached
 * the handler as a PrismaClientKnownRequestError whose code was the errno,
 * and the outage answered 500 with no Retry-After (measured with real OS
 * errnos: 240.0.0.1 gives ENETUNREACH, 255.255.255.255 EADDRNOTAVAIL).
 * Prisma 6 reported them as an unreachable server, a 503.
 */
describe("a database the network cannot reach, through the real driver and handler", () => {
  for (const errno of Object.keys(CONNECT_ERRNOS)) {
    for (const query of ["model", "raw"]) {
      it(`answers 503 with Retry-After for ${errno} on a ${query} query`, async () => {
        const response = await app.inject({
          method: "GET",
          url: `/__test/database-route/${query}/${errno}`,
        });

        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe(
          String(DATABASE_RETRY_AFTER_SECONDS),
        );
        expect(response.json().code).toBe("SERVICE_UNAVAILABLE");

        // Neither the errno nor the address reaches the body.
        expect(response.body).not.toContain(errno);
        expect(response.body).not.toContain(CONNECT_ERRNOS[errno][1]);
      });
    }
  }
});
