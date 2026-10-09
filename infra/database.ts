import { PrismaClient } from "@prisma/client";

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

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
    transactionOptions: TRANSACTION_OPTIONS,
  });
};

type PrismaClientSingleton = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientSingleton | undefined;
};

const prisma = globalForPrisma.prisma ?? prismaClientSingleton();
export default prisma;
export { TRANSACTION_OPTIONS };

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
