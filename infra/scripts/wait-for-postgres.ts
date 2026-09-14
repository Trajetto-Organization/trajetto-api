import { PrismaClient } from "@prisma/client";

/**
 * Blocks until Postgres answers, or gives up.
 *
 * It runs before `prisma migrate deploy` in both `dev` and `start`, and in
 * production it is the difference between a restart that waits and a restart
 * that kills the service.
 *
 * The chain it breaks: a replica whose database is briefly unreachable gets
 * recreated by Swarm, runs `migrate deploy` at boot, fails in seconds against
 * the still-dead database, and exits. Three of those in under a minute
 * exhaust `max_attempts` and the task is never recreated again. Waiting here
 * turns those seconds into minutes, which is long enough for almost every
 * real interruption — a failover, a restart, a node rescheduling the database
 * task — to resolve on its own.
 *
 * Bounded on purpose. Waiting forever would hide a genuinely wrong
 * DATABASE_URL behind a container that looks like it is starting, and a
 * misconfiguration should fail loudly rather than hang. After the deadline it
 * exits non-zero and the orchestrator does what it does with a boot failure.
 *
 * The previous version ran `docker exec -u root trajetto-database pg_isready`
 * and recursed without a delay or a limit. Inside the container there is no
 * docker binary and no such host, so it never worked anywhere but on a
 * developer's machine — and even there it spun the CPU.
 */
const MAX_WAIT_MS = Number(process.env.WAIT_FOR_POSTGRES_TIMEOUT_MS ?? 120_000);
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  // Its own client, disconnected at the end: this runs before the app exists,
  // and a pool left open would outlive the script in the `run-s` chain.
  const prisma = new PrismaClient({ log: [] });

  let lastError: unknown = null;

  try {
    for (;;) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        console.log("\n🟢 Postgres is ready and accepting connections!\n");

        return;
      } catch (error) {
        lastError = error;

        if (Date.now() + RETRY_DELAY_MS >= deadline) break;

        process.stdout.write(".");
        await sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  console.error(
    `\n🔴 Postgres did not answer within ${Math.round(MAX_WAIT_MS / 1000)}s.`,
  );

  console.error(lastError instanceof Error ? lastError.message : lastError);

  process.exit(1);
}

process.stdout.write("\n\n⚡ Waiting for Postgres to accept connections");

void waitForPostgres();
