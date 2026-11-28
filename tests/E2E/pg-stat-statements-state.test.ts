import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import { readPgStatStatementsState } from "@/shared/health/pg-stat-statements-state";

/**
 * pg_stat_statements, the per-query cost the scale plan measures against
 * (plano-escala F1, item F1-05).
 *
 * The extension comes from a migration that tolerates a user who cannot
 * create it, and the view only answers when the server preloads the library
 * (shared_preload_libraries), which today's production image does not. So
 * the reader says which of three states the database is in, and never turns
 * "not there yet" into an error: the metrics and the hourly snapshot read
 * it before touching the view.
 *
 * The test server preloads it (the E2E jobs of validate.yml, by ALTER
 * SYSTEM and a restart; docs/testes.md for a local run), so the migrated
 * database must read "ready" here: a migration that stopped creating the
 * extension, or a CI step that lost the preload, turns this red.
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the pg_stat_statements state", () => {
  it("is ready on the migrated database of a server that preloads it", async () => {
    expect(await readPgStatStatementsState(prisma)).toBe("ready");
  });

  it("is missing once the extension is gone, without an error", async () => {
    // DDL is transactional: the extension is dropped inside a transaction
    // that is rolled back, so nothing survives the test.
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP EXTENSION pg_stat_statements`);

        const state = await readPgStatStatementsState(tx);

        throw Object.assign(new Error("rollback"), { state });
      })
      .catch((error: Error & { state?: string }) => {
        if (!error.state) throw error;
        return error.state;
      });

    expect(seen).toBe("missing");
    expect(await readPgStatStatementsState(prisma)).toBe("ready");
  });
});
