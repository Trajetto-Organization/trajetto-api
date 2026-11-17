import { Prisma } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import { commitWriteConflict } from "../../support/serialization-failure";

import {
  SERVICE_BUSY_MESSAGE,
  SERVICE_BUSY_RETRY_AFTER_SECONDS,
  databaseBusyAnswer,
} from "@/shared/errors/database-error-map";

/**
 * A lock wait or a statement that ran past its ceiling is the database
 * being busy, not the code being broken (plano-escala U-13).
 *
 * The runtime URL has carried `lock_timeout=5000` for a long time, and it
 * bounds the `pg_advisory_xact_lock` waits of the delivery, route, kanban,
 * API key and webhook repositories too. A wait that ran out (55P03), or a
 * statement cancelled by statement_timeout (57014), left the error handler
 * as "Internal server error": a 500 a generic client does not retry, and a
 * stack trace among the real bugs. It is a 503 SERVICE_BUSY with a short
 * Retry-After now; the app and the web already treat a 503 as temporary.
 *
 * Shapes as @prisma/client 7.10.1 + @prisma/adapter-pg 7.10.1 raise them
 * (a raw query's P2010, a model query's P2039, the bare adapter error of a
 * COMMIT); the real ones, against Postgres, are in
 * tests/E2E/lock-timeout-mapping.test.ts. No database here.
 */
const clientVersion = Prisma.prismaVersion.client;

/** adapter-pg's cause for a SQLSTATE it has no kind of its own for. */
const postgresCause = (code: string, message: string) => ({
  kind: "postgres",
  originalCode: code,
  originalMessage: message,
  code,
  severity: "ERROR",
  message,
});

const adapterError = (cause: Record<string, unknown>) =>
  Object.assign(new Error(String(cause.kind)), {
    name: "DriverAdapterError",
    cause,
  });

const prismaFailure = (
  code: "P2010" | "P2039",
  cause: Record<string, unknown>,
) =>
  new Prisma.PrismaClientKnownRequestError(
    code === "P2010" ? "Raw query failed." : "Database error.",
    {
      code,
      clientVersion,
      meta: { driverAdapterError: adapterError(cause) },
    },
  );

const LOCK = "canceling statement due to lock timeout";
const STATEMENT = "canceling statement due to statement timeout";

const busy: Record<string, [() => unknown, string]> = {
  // pg_advisory_xact_lock through $executeRaw: every advisory key site.
  "an advisory lock wait (P2010, 55P03)": [
    () => prismaFailure("P2010", postgresCause("55P03", LOCK)),
    "lock_timeout",
  ],
  // A row another transaction holds, through a model query.
  "a row lock wait (P2039, 55P03)": [
    () => prismaFailure("P2039", postgresCause("55P03", LOCK)),
    "lock_timeout",
  ],
  "a raw statement past its ceiling (P2010, 57014)": [
    () => prismaFailure("P2010", postgresCause("57014", STATEMENT)),
    "statement_timeout",
  ],
  "a model statement past its ceiling (P2039, 57014)": [
    () => prismaFailure("P2039", postgresCause("57014", STATEMENT)),
    "statement_timeout",
  ],
  // Prisma 6's raw shape: the SQLSTATE in `meta.code`.
  "Prisma 6's raw shape (P2010, meta.code 55P03)": [
    () =>
      new Prisma.PrismaClientKnownRequestError("Raw query failed.", {
        code: "P2010",
        clientVersion,
        meta: { code: "55P03", message: LOCK },
      }),
    "lock_timeout",
  ],
  // A deferred trigger cancelled at COMMIT: the adapter's error, bare.
  "a COMMIT past its ceiling (bare adapter error, 57014)": [
    () => adapterError(postgresCause("57014", STATEMENT)),
    "statement_timeout",
  ],
};

const notBusy: Record<string, () => unknown> = {
  "a serialization conflict at COMMIT": () => commitWriteConflict(),
  "a unique violation": () =>
    prismaFailure("P2039", {
      kind: "UniqueConstraintViolation",
      originalCode: "23505",
      constraint: { index: "driver_businessId_cpf_key" },
    }),
  "an SQL error": () =>
    prismaFailure("P2010", postgresCause("42P01", "relation does not exist")),
  // The database going away is SERVICE_UNAVAILABLE's, not this map's.
  "a terminated backend": () =>
    prismaFailure("P2010", postgresCause("57P01", "terminating connection")),
  // The SQLSTATE on something that is neither Prisma's nor the adapter's.
  "a plain Error with the code": () =>
    Object.assign(new Error(LOCK), { code: "55P03" }),
  "the adapter's cause on a plain Error": () =>
    Object.assign(new Error(LOCK), { cause: postgresCause("55P03", LOCK) }),
  "a plain object": () => ({
    name: "DriverAdapterError",
    cause: postgresCause("55P03", LOCK),
  }),
  "nothing at all": () => undefined,
};

describe("databaseBusyAnswer", () => {
  for (const [name, [build, reason]] of Object.entries(busy)) {
    it(`answers 503 SERVICE_BUSY for ${name}`, () => {
      expect(databaseBusyAnswer(build())).toEqual({
        statusCode: 503,
        code: "SERVICE_BUSY",
        message: "O sistema está ocupado; tente de novo em instantes.",
        retryAfterSeconds: 2,
        reason,
        sqlState: reason === "lock_timeout" ? "55P03" : "57014",
      });
    });
  }

  for (const [name, build] of Object.entries(notBusy)) {
    it(`leaves ${name} alone`, () => {
      expect(databaseBusyAnswer(build())).toBeNull();
    });
  }
});

type App = Awaited<typeof import("@/http")>["app"];

let app: App;

const all: Record<string, () => unknown> = {
  ...Object.fromEntries(
    Object.entries(busy).map(([name, [build]]) => [name, build]),
  ),
  ...notBusy,
};
const names = Object.keys(all);

beforeAll(async () => {
  ({ app } = await import("@/http"));

  // Before `ready()`: through the real hooks and the real error handler.
  app.get<{ Params: { index: string } }>(
    "/__test/database-busy/:index",
    { config: { rateLimit: false } },
    async (request) => {
      throw all[names[Number(request.params.index)]]();
    },
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const call = (name: string) =>
  app.inject({
    method: "GET",
    url: `/__test/database-busy/${names.indexOf(name)}`,
  });

describe("the global error handler", () => {
  for (const name of Object.keys(busy)) {
    it(`answers 503 with Retry-After for ${name}`, async () => {
      const response = await call(name);

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe(
        String(SERVICE_BUSY_RETRY_AFTER_SECONDS),
      );
      // Generated clients' serializers drop `code`; the header survives.
      expect(response.headers["x-error-code"]).toBe("SERVICE_BUSY");
      // The outage's shape: a client of the published 503 needs nothing new.
      expect(response.json()).toEqual({
        code: "SERVICE_BUSY",
        message: SERVICE_BUSY_MESSAGE,
        requestId: response.headers["x-request-id"],
      });
      // Nothing of Postgres' or Prisma's words reaches the body.
      expect(response.body).not.toMatch(/55P03|57014|P20|canceling/i);
    });
  }

  it("still answers 500 without Retry-After for an SQL error", async () => {
    const response = await call("an SQL error");

    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("INTERNAL_ERROR");
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("still answers SERVICE_UNAVAILABLE for a terminated backend", async () => {
    const response = await call("a terminated backend");

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("SERVICE_UNAVAILABLE");
  });

  it("still answers 500 for the SQLSTATE on an untyped error", async () => {
    const response = await call("a plain Error with the code");

    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBeUndefined();
  });
});
