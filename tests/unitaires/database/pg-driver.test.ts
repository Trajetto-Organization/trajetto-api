import { describe, expect, it } from "vitest";

import {
  DatabaseUnavailableError,
  createPool,
  typedDriverError,
} from "@/shared/database/pg-driver";
import { poolSettingsFrom } from "@/shared/database/pool-config";

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
    "timeout exceeded when trying to connect",
    "Connection terminated due to connection timeout",
    "timeout expired",
    "Connection terminated unexpectedly",
    "Connection terminated",
    "Query read timeout",
    "Client was closed and is not queryable",
  ])("types pg's %j as the database being unavailable", (message) => {
    const original = new Error(message);
    const typed = typedDriverError(original);

    expect(typed).toBeInstanceOf(DatabaseUnavailableError);
    expect((typed as DatabaseUnavailableError).cause).toBe(original);
    expect((typed as Error).message).toBe(message);
  });

  it("leaves Postgres' own errors for the adapter to map (they carry a code)", () => {
    const refused = Object.assign(
      new Error("Connection terminated unexpectedly"),
      {
        code: "57P01",
      },
    );

    expect(typedDriverError(refused)).toBe(refused);
  });

  it("leaves any other error as it is", () => {
    const bug = new TypeError("Cannot read properties of undefined");

    expect(typedDriverError(bug)).toBe(bug);
    expect(typedDriverError("text")).toBe("text");
  });

  it("does not wrap twice", () => {
    const typed = new DatabaseUnavailableError(new Error("Query read timeout"));

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
