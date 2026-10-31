import { createPrismaClient } from "../../src/shared/database/database-client";

import { emptyDatabaseRefusal } from "./database-bootstrap-guard";
import { readSchemaVersion, schemaRefusal } from "./schema-guard";

/**
 * Blocks until Postgres answers, or gives up.
 *
 * It runs first in `yarn dev` (before `prisma migrate deploy`) and in both
 * modes of docker-entrypoint.sh: before the release step migrates, and
 * before a replica serves. In production it is the difference between a
 * restart that waits and a restart that kills the service.
 *
 * The chain it breaks: a replica whose database is briefly unreachable gets
 * recreated by Swarm, fails in seconds against the still-dead database, and
 * exits — a crash loop that, back when the restart policy had
 * `max_attempts`, made Swarm give up on the task for good.
 * Waiting here turns those seconds into minutes, which is long enough for
 * almost every real interruption — a failover, a restart — to resolve on its
 * own.
 *
 * Answering is not enough, though. A database task rescheduled onto an empty
 * local volume answers too, and in production that must stop the boot rather
 * than be migrated and seeded into a "healthy" empty system — see
 * database-bootstrap-guard.ts. It is checked here because this is the first
 * step of docker-entrypoint.sh in BOTH modes, before anything is written.
 *
 * `--require-migrations <build/schema-version.json>` (a replica's boot,
 * never the release step) also refuses a database that lacks the build's
 * last migration — see schema-guard.ts.
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

/**
 * The migration the boot requires, or null when not asked to check. Read
 * before waiting: a build without the file is a broken image, not a
 * database that is late.
 */
function requiredMigration(argv: string[]): string | null {
  const flag = argv.indexOf("--require-migrations");

  if (flag === -1) return null;

  const file = argv[flag + 1];

  if (!file) {
    console.error(
      "\n🔴 --require-migrations precisa do caminho de schema-version.json.\n",
    );
    process.exit(64);
  }

  try {
    return readSchemaVersion(file).latestMigration;
  } catch (error) {
    console.error(
      `\n🔴 ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(64);
  }
}

const REQUIRED_MIGRATION = requiredMigration(process.argv);

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  // Its own client, disconnected at the end: this runs before the app exists,
  // and a pool left open would outlive the script in the `run-s` chain. Built
  // like the app's, so connect_timeout (or pool_timeout, when smaller) bounds
  // each attempt (pg has no connect timeout of its own).
  const prisma = createPrismaClient({ log: [] });

  let lastError: unknown = null;
  let answered = false;
  let refusal: string | null = null;

  try {
    for (;;) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        console.log("\n🟢 Postgres is ready and accepting connections!\n");

        refusal = await emptyDatabaseRefusal(prisma);

        if (!refusal && REQUIRED_MIGRATION) {
          refusal = await schemaRefusal(prisma, REQUIRED_MIGRATION);
        }

        answered = true;

        break;
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

  if (answered) {
    if (refusal) {
      console.error(`\n🔴 ${refusal}\n`);

      process.exit(1);
    }

    return;
  }

  console.error(
    `\n🔴 Postgres did not answer within ${Math.round(MAX_WAIT_MS / 1000)}s.`,
  );

  console.error(lastError instanceof Error ? lastError.message : lastError);

  process.exit(1);
}

process.stdout.write("\n\n⚡ Waiting for Postgres to accept connections");

void waitForPostgres();
