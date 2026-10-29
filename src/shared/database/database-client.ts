import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";
import type pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";

import { createPool } from "./pg-driver";
import { poolSettingsFrom, type DatabasePoolSettings } from "./pool-config";

/**
 * Every PrismaClient of the API, its scripts and its tests is built here
 * (Prisma 7).
 *
 * Prisma 7 talks to Postgres through a driver adapter, and the pool is the
 * driver's: the settings Prisma 6 read from DATABASE_URL are mapped in
 * pool-config.ts, pg's own failures are typed in pg-driver.ts, and both only
 * hold if every client goes through the same door — the app's, the readiness
 * probe's, wait-for-postgres', and the hundreds the integration tests open.
 *
 * Each Prisma connect gets a FRESH pg Pool, and `$disconnect()` ends it.
 * That keeps Prisma 6's meaning of the two calls, which scripts (exit once
 * disconnected), the readiness probe (reconnect after a "no") and the tests
 * (disconnect in afterAll, sometimes query again) rely on: with one pool
 * shared across connects, `$disconnect()` either left the sockets open or
 * left the client unusable.
 */

type ClientOptions = Omit<
  Prisma.PrismaClientOptions,
  "adapter" | "accelerateUrl"
>;

interface ConnectionOptions {
  /** The database URL; DATABASE_URL at connect time when absent. */
  url?: string;

  /** Settings that win over the URL's (the readiness probe's own pool). */
  overrides?: Partial<Omit<DatabasePoolSettings, "connectionString">>;
}

interface DatabaseConnection<Client> {
  client: Client;

  /** The pool of the current connection; null before the first query. */
  pool(): pg.Pool | null;
}

let environmentLoaded = false;

/**
 * Prisma 6 read `.env` (with `${VAR}` expansion) itself when a client was
 * built; scripts such as the seed relied on it. Done here, once, and only
 * when DATABASE_URL is not already in the environment — a variable set by
 * the shell or the container always wins, as before.
 */
function loadEnvironmentOnce(): void {
  if (environmentLoaded || process.env.DATABASE_URL) return;

  environmentLoaded = true;
  dotenvExpand.expand(dotenv.config());
}

function settingsFor(connection: ConnectionOptions): DatabasePoolSettings {
  loadEnvironmentOnce();

  const settings = poolSettingsFrom(connection.url ?? process.env.DATABASE_URL);

  return { ...settings, ...connection.overrides };
}

type AdapterFactory = NonNullable<Prisma.PrismaClientOptions["adapter"]>;

/** `@prisma/adapter-pg`, over a pool built per connect (see above). */
function adapterFactory(
  connection: ConnectionOptions,
  onPool: (pool: pg.Pool) => void,
): AdapterFactory {
  return {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    async connect() {
      const settings = settingsFor(connection);
      const pool = createPool(settings);

      onPool(pool);

      return new PrismaPg(pool, {
        schema: settings.schema,
        // $disconnect() ends this pool; the next connect builds another.
        disposeExternalPool: true,
      }).connect();
    },
  };
}

/** A PrismaClient on its own pool, with that pool in reach (metrics). */
function createDatabaseClient<
  Options extends ClientOptions = Prisma.PrismaClientOptions,
>(
  options?: Options,
  connection: ConnectionOptions = {},
): DatabaseConnection<PrismaClient<Options>> {
  let current: pg.Pool | null = null;

  const client = new PrismaClient({
    ...options,
    adapter: adapterFactory(connection, (pool) => {
      current = pool;
    }),
  }) as unknown as PrismaClient<Options>;

  return { client, pool: () => current };
}

/** A PrismaClient on its own pool. */
function createPrismaClient<
  Options extends ClientOptions = Prisma.PrismaClientOptions,
>(
  options?: Options,
  connection: ConnectionOptions = {},
): PrismaClient<Options> {
  return createDatabaseClient(options, connection).client;
}

export { createDatabaseClient, createPrismaClient };
export type { ConnectionOptions, DatabaseConnection };
