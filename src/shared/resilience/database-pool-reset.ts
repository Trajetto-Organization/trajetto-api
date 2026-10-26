import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Gives the API a fresh connection pool after Postgres closed a connection.
 *
 * Prisma 6.1 (quaint) marks a pooled connection broken only when a statement
 * that was ALREADY prepared on it fails. Preparing a new statement goes out
 * without that check: on a connection whose backend is gone it fails with
 * P1017 ("Server has closed the connection") and the connection goes back to
 * the pool as healthy. The pool hands the same connection out again, the next
 * statement it never prepared fails the same way, and so on — after a
 * Postgres restart, a failover or a terminated backend, a replica answered
 * 503 to every request until it was restarted, while liveness stayed green
 * (CI: tests/E2E/database-reconnect.test.ts, `503 × 25`).
 *
 * The engine offers no way to drop one connection, so the first P1017 closes
 * the whole pool with `$disconnect()`; the next query connects again on the
 * same client (the same move the readiness probe makes on its own client).
 * The disconnect waits for the queries in flight, and queries issued while it
 * runs wait for it and go out on new connections. What it costs: an
 * interactive transaction open on a healthy connection of this replica at
 * that moment is lost, and the request that hit P1017 still fails (it may
 * have committed — see isDatabaseUnavailable). P1017 is rare outside an
 * outage, and in an outage every connection is dead anyway.
 *
 * Only P1017: a database that is down fails new connections with P1001 /
 * P1002, and a full pool with P2024 — a reset would fix neither.
 */
function isClosedConnection(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P1017"
  );
}

interface Disconnectable {
  $disconnect: () => Promise<void>;
}

/**
 * Returns `resetAfter(error)`: on P1017, closes the pool unless a close is
 * already running (a burst of failures resets once). Never throws.
 */
function createPoolReset(
  client: Disconnectable,
  onReset?: (error: unknown) => void,
): (error: unknown) => void {
  let resetting: Promise<void> | null = null;

  return (error) => {
    if (resetting || !isClosedConnection(error)) return;

    try {
      onReset?.(error);
    } catch {
      // A failing log line must not keep the pool broken.
    }

    resetting = client
      .$disconnect()
      .catch(() => {})
      .finally(() => {
        resetting = null;
      });
  };
}

/**
 * The client with the reset wired into every operation — model queries, raw
 * queries and the queries inside a transaction. The error is rethrown as is,
 * so callers classify it exactly as before.
 *
 * Typed back as PrismaClient: a query extension does not change what any
 * operation accepts or returns, and every repository takes a PrismaClient.
 */
function withPoolReset(
  client: PrismaClient,
  onReset?: (error: unknown) => void,
): PrismaClient {
  const resetAfter = createPoolReset(client, onReset);

  return client.$extends({
    name: "database-pool-reset",
    query: {
      async $allOperations({ args, query }) {
        try {
          return await query(args);
        } catch (error) {
          resetAfter(error);
          throw error;
        }
      },
    },
  }) as unknown as PrismaClient;
}

export { createPoolReset, isClosedConnection, withPoolReset };
