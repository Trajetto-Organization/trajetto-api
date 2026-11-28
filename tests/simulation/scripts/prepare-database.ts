import { spawnSync } from "node:child_process";

import pg from "pg";

import { prismaArgs } from "../lib/guarded-node";
import {
  API_ROOT,
  SIM_DATABASE_NAME,
  assertSimDatabase,
  forgetPreviousRun,
  simDatabaseUrl,
} from "../lib/sim-config";

/**
 * Recreates the simulation's own database and migrates it, from scratch:
 *
 *   npx tsx tests/simulation/scripts/prepare-database.ts
 *
 * DROP + CREATE of `trajetto_sim` on the shared test container
 * (127.0.0.1:54321), then `prisma migrate deploy` against it. Refuses any
 * other host, port or database name (sim-config.ts). Stop the replicas
 * first: the drop terminates their connections (WITH (FORCE)).
 *
 * SIM_KEEP_DATABASE=1 keeps an existing database and only migrates it.
 */
async function main(): Promise<void> {
  const url = simDatabaseUrl();

  assertSimDatabase(url);

  // The same server, connected to its maintenance database.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";

  const client = new pg.Client({ connectionString: admin.toString() });

  await client.connect();

  try {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [SIM_DATABASE_NAME],
    );
    const exists = (rowCount ?? 0) > 0;

    if (exists && process.env.SIM_KEEP_DATABASE !== "1") {
      console.log(`[sim] Apagando o banco ${SIM_DATABASE_NAME}…`);
      await client.query(
        `DROP DATABASE IF EXISTS "${SIM_DATABASE_NAME}" WITH (FORCE)`,
      );
    }

    if (!exists || process.env.SIM_KEEP_DATABASE !== "1") {
      console.log(`[sim] Criando o banco ${SIM_DATABASE_NAME}…`);
      await client.query(`CREATE DATABASE "${SIM_DATABASE_NAME}"`);
    }
  } finally {
    await client.end();
  }

  console.log("[sim] prisma migrate deploy…");

  // With the .env guard: prisma.config.ts runs dotenv from the API folder,
  // and the developer's .env there is never read (lib/no-env-file.cjs).
  const result = spawnSync(process.execPath, prismaArgs("migrate", "deploy"), {
    cwd: API_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });

  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy terminou com ${result.status}.`);
  }

  // The company the previous run's context names is gone with the database.
  if (process.env.SIM_KEEP_DATABASE !== "1") forgetPreviousRun();

  console.log(`[sim] Banco ${SIM_DATABASE_NAME} pronto.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
