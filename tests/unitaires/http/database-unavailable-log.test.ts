import { Prisma } from "@prisma/client";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { AppError } from "@/shared/errors/AppError";

/**
 * An outage is logged as an outage on EVERY route, authenticated or not
 * (GAP6-3).
 *
 * The global handler gives a database that is down its own message, so an
 * alert on bugs does not page for an outage the readiness probe already
 * sees. But on an authenticated route the outage reaches the handler as the
 * session middleware's AUTH_SESSION_UNAVAILABLE — an AppError — and was
 * logged as "Unhandled error while processing request", the very line the
 * bug alert keys on. Authenticated routes are most of the traffic, so a
 * Postgres restart still paged as a bug.
 *
 * No database: every route below throws before touching one.
 */
const kinds: Record<string, () => Error> = {
  // What ensure-authenticated throws, and ONLY for an error the classifier
  // recognised as the database being unavailable.
  "session-outage": () =>
    new AppError(
      "Não foi possível verificar sua sessão agora. Tente novamente.",
      503,
      "AUTH_SESSION_UNAVAILABLE",
    ),
  database: () =>
    new Prisma.PrismaClientKnownRequestError("Server has closed the connection.", {
      code: "P1017",
      clientVersion: Prisma.prismaVersion.client,
    }),
  bug: () => new TypeError("Cannot read properties of undefined (reading 'role')"),
};

type Line = { level: "error" | "warn"; message: string };

const lines: Line[] = [];

type App = Awaited<typeof import("@/http")>["app"];

let app: App;

beforeAll(async () => {
  ({ app } = await import("@/http"));

  app.get<{ Params: { kind: string } }>(
    "/__test/database-log/:kind",
    {
      config: { rateLimit: false },
      // The handler logs through request.log; record what it writes, keeping
      // the real logger underneath for everything else.
      onRequest: async (request) => {
        const real = request.log;

        request.log = Object.assign(Object.create(real), {
          error: (_context: unknown, message: string) => {
            lines.push({ level: "error", message });
          },
          warn: (_context: unknown, message: string) => {
            lines.push({ level: "warn", message });
          },
        });
      },
    },
    async (request) => {
      throw kinds[request.params.kind]();
    },
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  lines.length = 0;
});

const call = (kind: string) =>
  app.inject({ method: "GET", url: `/__test/database-log/${kind}` });

describe("the error handler's log line", () => {
  it("names the outage when the session check could not reach the database", async () => {
    const response = await call("session-outage");

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");

    expect(lines).toEqual([
      { level: "error", message: "Database unavailable while processing request" },
    ]);
  });

  it("names the outage when a route hit the database directly", async () => {
    const response = await call("database");

    expect(response.statusCode).toBe(503);
    expect(lines).toEqual([
      { level: "error", message: "Database unavailable while processing request" },
    ]);
  });

  it("keeps calling a bug a bug", async () => {
    const response = await call("bug");

    expect(response.statusCode).toBe(500);
    expect(lines).toEqual([
      { level: "error", message: "Unhandled error while processing request" },
    ]);
  });
});
