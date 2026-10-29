import type pg from "pg";
import type { PrismaClient } from "@prisma/client";

import { createDatabaseClient } from "../src/shared/database/database-client";

/**
 * How long an interactive transaction may wait for a connection, and run.
 *
 * Prisma's defaults are 2 s and 5 s, while a plain query waits `pool_timeout`
 * (20 s in the production URL) for a connection. So when reads filled the
 * pool, the write in a `$transaction` — a proof of delivery, an occurrence, a
 * route transition — was the first request to fail (P2028), and the reads it
 * lost to carried on. Ten seconds is five times that patience, and stays under
 * `pool_timeout` because nothing past it would count: the pool's own timeout
 * (pg-pool's "timeout exceeded when trying to connect", typed as
 * DatabaseUnavailableError in src/shared/database/pg-driver.ts; P2024 under
 * Prisma 6) ends the same wait first. A write can still give up before a read
 * that waits the full 20 s; what keeps both from waiting that long is that the
 * delivery and dashboard screens take at most two connections each (see
 * DeliveryRepository.operationSummary). Options passed on a single call still
 * win.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * The application's client, on a pool sized and timed by DATABASE_URL
 * (src/shared/database/pool-config.ts).
 *
 * Under Prisma 6 it was wrapped in withPoolReset, which closed the whole pool
 * on P1017: Prisma 6.1's pool handed a connection Postgres had closed back
 * out as healthy, and the replica answered 503 until restarted. pg's pool
 * drops a connection that failed or died (and pg-driver.ts closes one that
 * outlived socket_timeout), so there is nothing left to reset — and with the
 * driver adapter, `$disconnect()` would end the pool under every request in
 * flight. tests/E2E/database-reconnect.test.ts proves the recovery.
 */
const prismaClientSingleton = () => {
  const { client, pool } = createDatabaseClient({
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
    transactionOptions: TRANSACTION_OPTIONS,
  });

  // Typed back as PrismaClient, as before: every repository takes one.
  return { client: client as unknown as PrismaClient, pool };
};

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPool: (() => pg.Pool | null) | undefined;
};

/**
 * A client a test put on globalThis before importing the app (the statement
 * budgets count queries that way) is used as it is; its pool is not ours.
 */
const connection = globalForPrisma.prisma
  ? {
      client: globalForPrisma.prisma,
      pool: globalForPrisma.prismaPool ?? (() => null),
    }
  : prismaClientSingleton();

const prisma = connection.client;

/** The pg Pool behind the client: /health/metrics and the minute log line. */
const databasePool = connection.pool;

export default prisma;
export { TRANSACTION_OPTIONS, databasePool };

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaPool = databasePool;
}
