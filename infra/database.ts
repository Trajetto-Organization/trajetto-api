import type pg from "pg";
import type { PrismaClient } from "@prisma/client";

import {
  createDatabaseClient,
  type DatabaseConnection,
} from "../src/shared/database/database-client";

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

/**
 * The two side pools (plano-escala F3-16, section 2.4 of the plan), each on
 * its own small pool so that what it runs cannot take the connections the
 * requests need:
 *
 *  - databaseRead, the bulkhead of the heavy reads (exports, long lists):
 *    DATABASE_READ_URL, else DATABASE_URL; 3 connections, 10 s a
 *    statement. From wave 17 its URL may point at the standby. Who may use
 *    it is a closed list (tests/unitaires/database/database-read-guard.test.ts):
 *    never a middleware, a socket admission, a queue claim, an idempotency
 *    key or a compare-and-set, which must read the primary's latest write.
 *  - databaseBatch, the maintenance (purges, partitions, the heavy
 *    metrics, pg_stat_statements): BATCH_DATABASE_URL, else DATABASE_URL;
 *    3 connections, 30 min a statement, a direct URL (never PgBouncer).
 *    After the cut of the database roles it is the trajetto_batch login,
 *    the one with pg_read_all_stats and the partition owner's role.
 *
 * Lazy twice over: the client is only built on the first use (a
 * PrismaClient is not free, and most processes never touch one of them),
 * and its pool opens a connection only for a statement and closes it after
 * the URL's idle lifetime. With neither URL set, at most 3 more
 * connections per side pool, and only while one is in use.
 *
 * The `-read`/`-batch` suffix of application_name comes with F3-02.
 */
const READ_POOL = { max: 3, statementTimeoutMs: 10_000 } as const;
const BATCH_POOL = { max: 3, statementTimeoutMs: 30 * 60_000 } as const;

/** A URL from the environment; empty counts as absent. */
function environmentUrl(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value ? value : undefined;
}

/** A PrismaClient built on its first property access. */
function lazyClient(build: () => DatabaseConnection<PrismaClient>): {
  client: PrismaClient;
  pool: () => pg.Pool | null;
} {
  let connection: DatabaseConnection<PrismaClient> | null = null;
  const current = () => (connection ??= build());

  const client = new Proxy({} as PrismaClient, {
    get(_target, property) {
      const target = current().client;
      const value = Reflect.get(target, property, target) as unknown;

      // The client's own methods ($queryRaw, $transaction…) need it as
      // `this`; a model delegate (`.user`) is returned as it is.
      return typeof value === "function" &&
        typeof property === "string" &&
        property.startsWith("$")
        ? value.bind(target)
        : value;
    },
  });

  return { client, pool: () => connection?.pool() ?? null };
}

function sidePool(
  url: () => string | undefined,
  pool: { max: number; statementTimeoutMs: number },
) {
  return lazyClient(() => {
    const { client, pool: current } = createDatabaseClient(
      { log: [], transactionOptions: TRANSACTION_OPTIONS },
      {
        url,
        overrides: { max: pool.max },
        ceiling: { statementTimeoutMs: pool.statementTimeoutMs },
      },
    );

    return { client: client as unknown as PrismaClient, pool: current };
  });
}

/**
 * A test that put its own client on globalThis before importing the app
 * (the statement budgets and the plan checks count every statement the app
 * sends) gets the side pools' statements on it too: a purge moved to the
 * batch pool must still be counted and explained. Never in production,
 * where nothing puts a client there.
 */
const testClient = globalForPrisma.prisma
  ? { client: globalForPrisma.prisma, pool: connection.pool }
  : null;

const read =
  testClient ?? sidePool(() => environmentUrl("DATABASE_READ_URL"), READ_POOL);
const batch =
  testClient ??
  sidePool(() => environmentUrl("BATCH_DATABASE_URL"), BATCH_POOL);

/** The heavy reads' bulkhead: a closed list of callers only. */
const databaseRead = read.client;

/** The maintenance pool: crons, partitions, heavy metrics. */
const databaseBatch = batch.client;

/** The pools behind them, null until the first statement. */
const databaseReadPool = read.pool;
const databaseBatchPool = batch.pool;

export default prisma;
export {
  BATCH_POOL,
  READ_POOL,
  TRANSACTION_OPTIONS,
  databaseBatch,
  databaseBatchPool,
  databasePool,
  databaseRead,
  databaseReadPool,
};

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaPool = databasePool;
}
