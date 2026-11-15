import type { PrismaClient } from "@prisma/client";

/**
 * Until another backend of this database is waiting on a lock — the moment a
 * race test knows its second transaction is parked behind the first, so the
 * order it asserts is the one Postgres actually ran.
 *
 * Polls pg_stat_activity every 25 ms; throws after `timeoutMs`, naming
 * `what`, so a test whose writers never collided fails instead of passing
 * on a race that did not happen. With `query`, only a backend whose
 * statement contains that text counts: the one waiting where the test
 * means, not one parked somewhere else first.
 */
async function someoneWaitsOnALock(
  prisma: Pick<PrismaClient, "$queryRaw">,
  {
    timeoutMs = 8_000,
    what = "lock",
    query,
  }: { timeoutMs?: number; what?: string; query?: string } = {},
): Promise<void> {
  const until = Date.now() + timeoutMs;

  while (Date.now() < until) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "wait_event_type" = 'Lock'
        AND (${query ?? null}::text IS NULL
          OR strpos("query", ${query ?? null}::text) > 0)
    `;

    if (row.waiting > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`nobody ever waited on the ${what}`);
}

export { someoneWaitsOnALock };
