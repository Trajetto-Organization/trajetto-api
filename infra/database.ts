import { PrismaClient } from "@prisma/client";

import { withPoolReset } from "../src/shared/resilience/database-pool-reset";

/**
 * How long an interactive transaction may wait for a connection, and run.
 *
 * Prisma's defaults are 2 s and 5 s, while a plain query waits `pool_timeout`
 * (20 s in the production URL) for a connection. So when reads filled the
 * pool, the write in a `$transaction` — a proof of delivery, an occurrence, a
 * route transition — was the first request to fail (P2028), and the reads it
 * lost to carried on. Ten seconds is five times that patience, and stays under
 * `pool_timeout` because nothing past it would count: the pool's own timeout
 * (P2024) ends the same wait first. A write can still give up before a read
 * that waits the full 20 s; what keeps both from waiting that long is that the
 * delivery and dashboard screens take at most two connections each (see
 * DeliveryRepository.operationSummary). Options passed on a single call still
 * win.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * Logged when Postgres closed a connection and the pool is being replaced.
 * Imported on that path only: scripts load this module without the app's
 * environment, and a log line must never be the reason a query fails.
 */
function logPoolReset(error: unknown): void {
  import("../src/shared/logging/logger")
    .then(({ logger }) =>
      logger.warn(
        { component: "database", err: error },
        "Postgres closed a connection: replacing the connection pool",
      ),
    )
    .catch(() => {});
}

const prismaClientSingleton = () => {
  // See withPoolReset: without it, a connection Postgres closed could stay in
  // the pool for good and every request answer 503 until a restart.
  return withPoolReset(
    new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["query"] : [],
      transactionOptions: TRANSACTION_OPTIONS,
    }),
    logPoolReset,
  );
};

type PrismaClientSingleton = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientSingleton | undefined;
};

const prisma = globalForPrisma.prisma ?? prismaClientSingleton();
export default prisma;
export { TRANSACTION_OPTIONS };

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
