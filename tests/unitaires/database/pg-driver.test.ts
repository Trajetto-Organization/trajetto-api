import { afterEach, describe, expect, it, vi } from "vitest";

import type pg from "pg";

import {
  DatabaseUnavailableError,
  createPool,
  typedDriverError,
} from "@/shared/database/pg-driver";
import { poolSettingsFrom } from "@/shared/database/pool-config";

import {
  fakePostgres,
  systemError,
  type FakePostgres,
  type FakePostgresBehaviour,
} from "../../support/fake-postgres";

/**
 * pg's own failures, typed where they leave the API's pool.
 *
 * Prisma 7's pg adapter maps socket errors and Postgres' SQLSTATEs and
 * rethrows the rest untouched, so a full pool, a dead connection and a query
 * past socket_timeout reached the error handler as plain Errors — a 500, where
 * Prisma 6 raised P2024/P1017/P1008 and the API answered 503 + Retry-After.
 */
describe("typedDriverError", () => {
  it.each([
    ["timeout exceeded when trying to connect", "pool-timeout"],
    ["Connection terminated due to connection timeout", "connect-failed"],
    ["timeout expired", "connect-failed"],
    ["Connection terminated unexpectedly", "connection-lost"],
    ["Connection terminated", "connection-lost"],
    ["Query read timeout", "query-timeout"],
    ["Client was closed and is not queryable", "connection-lost"],
    [
      "Client has encountered a connection error and is not queryable",
      "connection-lost",
    ],
  ])(
    "types pg's %j as the database being unavailable (%s)",
    (message, reason) => {
      const original = new Error(message);
      const typed = typedDriverError(original);

      expect(typed).toBeInstanceOf(DatabaseUnavailableError);
      expect((typed as DatabaseUnavailableError).cause).toBe(original);
      expect((typed as DatabaseUnavailableError).reason).toBe(reason);
      expect((typed as Error).message).toBe(message);
    },
  );

  /**
   * The errnos the adapter does not map reached the app as a
   * PrismaClientKnownRequestError whose code was the errno: a 500 for an
   * outage. Built as Node raises them, with this platform's errno numbers.
   */
  it.each([
    ["EAI_AGAIN", "getaddrinfo", "db.internal"],
    ["EAI_FAIL", "getaddrinfo", "db.internal"],
    ["EHOSTUNREACH", "connect", "10.0.0.9:5432"],
    ["EHOSTDOWN", "connect", "10.0.0.9:5432"],
    ["ENETUNREACH", "connect", "240.0.0.1:5432"],
    ["ENETDOWN", "connect", "10.0.0.9:5432"],
    ["EADDRNOTAVAIL", "connect", "255.255.255.255:5432"],
    ["ECONNABORTED", "connect", "10.0.0.9:5432"],
  ])(
    "types %s from %s as a connection that could not be opened",
    (code, syscall, target) => {
      const original = systemError(code, syscall, target);
      const typed = typedDriverError(original);

      expect(typed).toBeInstanceOf(DatabaseUnavailableError);
      expect((typed as DatabaseUnavailableError).reason).toBe("connect-failed");
      expect((typed as DatabaseUnavailableError).cause).toBe(original);

      // No `code`: Prisma would turn the error back into a KnownRequestError.
      expect((typed as { code?: unknown }).code).toBeUndefined();
    },
  );

  it.each([
    ["EPIPE", "write"],
    ["EHOSTUNREACH", "read"],
    ["ECONNABORTED", "read"],
  ])(
    "types %s from %s on an open connection as one that may have sent a statement",
    (code, syscall) => {
      const typed = typedDriverError(systemError(code, syscall));

      expect(typed).toBeInstanceOf(DatabaseUnavailableError);
      expect((typed as DatabaseUnavailableError).reason).toBe(
        "connection-lost",
      );
    },
  );

  it.each([
    ["ECONNREFUSED", "connect", "127.0.0.1:5432"],
    ["ENOTFOUND", "getaddrinfo", "db.internal"],
    ["ECONNRESET", "read", undefined],
    ["ETIMEDOUT", "connect", "10.0.0.9:5432"],
  ])(
    "leaves %s for the adapter, which maps it to a Prisma code",
    (code, syscall, target) => {
      const socket = systemError(code, syscall, target);

      expect(typedDriverError(socket)).toBe(socket);
    },
  );

  it("leaves Postgres' own errors for the adapter to map (they carry a code)", () => {
    const refused = Object.assign(
      new Error("Connection terminated unexpectedly"),
      {
        code: "57P01",
      },
    );

    expect(typedDriverError(refused)).toBe(refused);
  });

  it("leaves an errno code without a syscall, which no socket raises", () => {
    const lookalike = Object.assign(new Error("EPIPE"), { code: "EPIPE" });

    expect(typedDriverError(lookalike)).toBe(lookalike);
  });

  it("leaves any other error as it is", () => {
    const bug = new TypeError("Cannot read properties of undefined");

    expect(typedDriverError(bug)).toBe(bug);
    expect(typedDriverError("text")).toBe("text");
  });

  it("does not wrap twice", () => {
    const typed = typedDriverError(new Error("Query read timeout"));

    expect(typedDriverError(typed)).toBe(typed);
  });
});

describe("createPool", () => {
  it("is built from the mapped settings, with a separate connect timeout", async () => {
    const pool = createPool(
      poolSettingsFrom(
        "postgresql://u:p@127.0.0.1:1/d?connection_limit=3&pool_timeout=20&connect_timeout=1&socket_timeout=60",
      ),
    );

    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.connectionTimeoutMillis).toBe(20_000);

      // Nothing listens on port 1: the connect fails on its own (refused, a
      // socket error with a code), and is NOT turned into a pool timeout.
      const failure = await pool.query("SELECT 1").catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(DatabaseUnavailableError);
      expect((failure as { code?: string }).code).toBe("ECONNREFUSED");
    } finally {
      await pool.end();
    }
  });
});

/**
 * The same failures raised for real by pg and pg-pool, against a server that
 * fails on cue (tests/support/fake-postgres.ts), and the `reason` each gets:
 * whether a statement may have reached the database decides whether the
 * audit trail may write again.
 */
describe("what the pool raises, and why", () => {
  let fake: FakePostgres | undefined;
  let pool: pg.Pool | undefined;

  afterEach(async () => {
    await pool?.end().catch(() => {});
    await fake?.close();
    pool = undefined;
    fake = undefined;
  });

  async function poolOn(
    behaviour: FakePostgresBehaviour,
    parameters: string,
  ): Promise<pg.Pool> {
    fake = await fakePostgres(behaviour);
    pool = createPool(poolSettingsFrom(`${fake.url}?${parameters}`));

    return pool;
  }

  async function failureOf(work: Promise<unknown>): Promise<unknown> {
    return work.then(
      () => {
        throw new Error("expected the database to be unavailable");
      },
      (error: unknown) => error,
    );
  }

  it("a full pool: pool-timeout, nothing sent", async () => {
    const pool = await poolOn(
      { kind: "ready", onQuery: "ignore" },
      "connection_limit=1&pool_timeout=0.3",
    );

    // The only connection, checked out and held.
    const held = await pool.connect();

    try {
      for (const attempt of [pool.connect(), pool.query("SELECT 1")]) {
        const failure = await failureOf(attempt);

        expect(failure).toBeInstanceOf(DatabaseUnavailableError);
        expect((failure as DatabaseUnavailableError).message).toBe(
          "timeout exceeded when trying to connect",
        );
        expect((failure as DatabaseUnavailableError).reason).toBe(
          "pool-timeout",
        );
      }
    } finally {
      held.release();
    }
  });

  it("a socket closed during the handshake: connect-failed, nothing sent", async () => {
    const pool = await poolOn(
      { kind: "close-on-startup" },
      "connection_limit=1&pool_timeout=5",
    );

    const failure = await failureOf(pool.query("SELECT 1"));

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).message).toBe(
      "Connection terminated unexpectedly",
    );
    expect((failure as DatabaseUnavailableError).reason).toBe("connect-failed");
  });

  it("the same words for a socket closed under a query: connection-lost, maybe sent", async () => {
    const pool = await poolOn(
      { kind: "ready", onQuery: "close" },
      "connection_limit=1&pool_timeout=5",
    );

    const failure = await failureOf(pool.query("SELECT 1"));

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).message).toBe(
      "Connection terminated unexpectedly",
    );
    expect((failure as DatabaseUnavailableError).reason).toBe(
      "connection-lost",
    );
  });

  it("a query past socket_timeout: query-timeout, maybe sent, and the connection is closed", async () => {
    const pool = await poolOn(
      { kind: "ready", onQuery: "ignore" },
      "connection_limit=1&pool_timeout=5&socket_timeout=0.3",
    );

    const client = await pool.connect();
    const failure = await failureOf(client.query("SELECT 1"));
    client.release();

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).message).toBe(
      "Query read timeout",
    );
    expect((failure as DatabaseUnavailableError).reason).toBe("query-timeout");

    await vi.waitFor(() => expect(fake?.connections()).toBe(0));
  });

  it("Postgres out of connection slots (53300) is left for the adapter, which maps it to P2037", async () => {
    const pool = await poolOn(
      {
        kind: "refuse",
        sqlState: "53300",
        message: "sorry, too many clients already",
      },
      "connection_limit=1&pool_timeout=5",
    );

    const failure = await failureOf(pool.query("SELECT 1"));

    expect(failure).not.toBeInstanceOf(DatabaseUnavailableError);
    expect(failure).toMatchObject({ code: "53300", severity: "FATAL" });
  });

  /**
   * pg-pool bounds the opening of a connection by its own timeout too, so a
   * connect gives up at the smaller of pool_timeout and connect_timeout —
   * which is what Prisma 6 did: its pool_timeout covered the whole checkout,
   * connect included (pool_timeout 1 s, connect_timeout 4 s gave P2024 at
   * 1 s). A connect_timeout above pool_timeout has no effect.
   */
  it.each([
    [
      "pool_timeout",
      "pool_timeout=0.3&connect_timeout=5",
      "Connection terminated due to connection timeout",
    ],
    [
      "connect_timeout",
      "pool_timeout=5&connect_timeout=0.3",
      "timeout expired",
    ],
  ])(
    "a host that never answers: connect-failed at the smaller timeout (%s)",
    async (_smaller, timeouts, message) => {
      const pool = await poolOn(
        { kind: "silent" },
        `connection_limit=1&${timeouts}`,
      );

      const started = Date.now();
      const failure = await failureOf(pool.query("SELECT 1"));
      const elapsed = Date.now() - started;

      expect(failure).toBeInstanceOf(DatabaseUnavailableError);
      expect((failure as DatabaseUnavailableError).message).toBe(message);
      expect((failure as DatabaseUnavailableError).reason).toBe(
        "connect-failed",
      );

      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3_000);
    },
  );
});
