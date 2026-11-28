// @vitest-environment node
import type { PrismaClient } from "@prisma/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import {
  ReplicaGuard,
  createReadRouter,
  prismaReplicaProbe,
} from "@/shared/database/replica-guard";

import { infraUrl } from "./support/infra-urls";

/**
 * The replica guard against the real standby of the infra phase
 * (plano-escala F4-41; tests/E2E/infra/run.sh).
 *
 * The acceptance: pausing the standby's replay sends the reads to the
 * primary. The heartbeat is written on the primary each round and its age
 * read on the standby; with the replay paused the row stops moving there,
 * its age passes the limit, and readDatabase() answers from the primary
 * until the standby has caught up for 3 rounds in a row. The limit here is
 * 1.5 s instead of 15 s, so the file does not wait a quarter of a minute;
 * the rule is the same.
 *
 * The replay is always resumed at the end: the files after this one read
 * the same standby.
 */
const LIMIT_MS = 1_500;

let primary: PrismaClient;
let standby: PrismaClient;
let control: pg.Client;

/** Whether the client answers from a server in recovery (the standby). */
async function inRecovery(client: PrismaClient): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ recovering: boolean }>>(
    "SELECT pg_is_in_recovery() AS recovering",
  );

  return rows[0].recovering;
}

beforeAll(async () => {
  primary = createPrismaClient({}, { url: infraUrl("primary") });
  standby = createPrismaClient({}, { url: infraUrl("standby") });
  control = new pg.Client({ connectionString: infraUrl("standby") });
  await control.connect();
});

afterAll(async () => {
  await control.query("SELECT pg_wal_replay_resume()").catch(() => undefined);
  await control.end();
  await standby.$disconnect();
  await primary.$disconnect();
});

describe("the replica guard on a real standby", () => {
  it("sends the reads to the primary while the replay is paused, and back to the standby once it caught up", async () => {
    const guard = new ReplicaGuard(prismaReplicaProbe(primary, standby), {
      maxLagMs: LIMIT_MS,
    });
    const router = createReadRouter<PrismaClient>({
      replicaUrl: () => infraUrl("standby"),
      replica: () => standby,
      primaryRead: () => primary,
      probe: () => prismaReplicaProbe(primary, standby),
      options: { maxLagMs: LIMIT_MS },
    });

    // The router's own guard: started by the first read, on the primary.
    expect(await inRecovery(router.readDatabase())).toBe(false);
    router.guard()!.stop();

    // Streaming: three good rounds and the reads go to the standby.
    for (let round = 0; round < 3; round++) {
      await guard.check();
      await router.guard()!.check();
    }
    expect(guard.onReplica).toBe(true);
    expect(guard.snapshot().lagMs).toBeLessThan(LIMIT_MS);
    expect(await inRecovery(router.readDatabase())).toBe(true);

    await control.query("SELECT pg_wal_replay_pause()");

    try {
      await vi.waitFor(
        async () => {
          await guard.check();
          await router.guard()!.check();
          expect(guard.onReplica).toBe(false);
        },
        { timeout: 15_000, interval: 250 },
      );

      expect(guard.snapshot().lagMs).toBeGreaterThan(LIMIT_MS);
      expect(await inRecovery(router.readDatabase())).toBe(false);

      // Still paused, still behind: it never returns on its own.
      await guard.check();
      expect(guard.onReplica).toBe(false);
    } finally {
      await control.query("SELECT pg_wal_replay_resume()");
    }

    await vi.waitFor(
      async () => {
        await guard.check();
        await router.guard()!.check();
        expect(guard.onReplica).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
    expect(guard.snapshot().streak).toBeGreaterThanOrEqual(3);
    expect(await inRecovery(router.readDatabase())).toBe(true);
  }, 45_000);
});
