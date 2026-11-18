import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

/**
 * The fingerprint of what every process of one environment must share
 * (plano-escala F3-03, X-04).
 *
 * With the roles, the owner creates each Application by copying the API's
 * Environment, and a copy can drift: a worker left on last month's
 * JWT_SECRET refuses nobody's token but signs nothing anybody accepts; one
 * with another SOCKET_ADAPTER_KEY emits into channels nobody listens to;
 * one pointed at another database or Redis does its work somewhere else.
 * None of that fails a boot. So each process hashes those settings, with
 * the identities of the database and the Redis it actually reached, and
 * writes the hash in its process_heartbeat row: the deploy's check (F3-31b)
 * fails when two live processes disagree.
 *
 * Never the values: only a sha256, cut to 16 hex, over every input at once
 * (the JWT keys carry ~192 bits each, so the hash gives nothing back). And
 * never a host: the database is named by its cluster's system_identifier
 * and its own name, the Redis by the run_id of its server, so the same
 * database reached directly or through PgBouncer, by one login or another,
 * gives the same fingerprint — switching the Applications to PgBouncer one
 * at a time (wave 17) must not fail every deploy in between.
 */

/** The settings hashed, by name, in this order. */
const FINGERPRINT_SETTINGS = [
  "JWT_SECRET",
  "JWT_SECRET_REFRESH_TOKEN",
  "SOCKET_ADAPTER_KEY",
  "WEBHOOK_SECRETS_KEY",
  "APP_ENV",
  "R2_BUCKET_NAME",
  "MIN_MOBILE_CONTRACT",
] as const;

type FingerprintSettings = Partial<
  Record<(typeof FINGERPRINT_SETTINGS)[number], string | number | undefined>
>;

/** What the process reached, as the servers name themselves. */
interface FingerprintIdentities {
  /** `<system_identifier>/<current_database()>`. */
  database: string;

  /** The counters' Redis server's run_id (INFO server). */
  redis: string;
}

/** Hex characters kept: 64 bits, plenty to tell two configurations apart. */
const FINGERPRINT_LENGTH = 16;

function configFingerprint(
  settings: FingerprintSettings,
  identities: FingerprintIdentities,
): string {
  const hash = createHash("sha256");

  // Name, NUL, value, NUL: no value can run into the next one, and an
  // absent setting hashes apart from an empty one by its position alone.
  for (const name of FINGERPRINT_SETTINGS) {
    const value = settings[name];

    hash.update(`${name}\0${value === undefined ? "" : String(value)}\0`);
  }

  hash.update(`database\0${identities.database}\0redis\0${identities.redis}\0`);

  return hash.digest("hex").slice(0, FINGERPRINT_LENGTH);
}

type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The database as it names itself: the cluster's system_identifier as the
 * release step recorded it (cluster_epoch, U-14), or the cluster's own
 * before the step ever ran, and the database's name. pg_control_system()
 * is executable by every role on Postgres 16, PgBouncer passes it through,
 * and the runtime roles read cluster_epoch.
 */
async function readDatabaseIdentity(client: RawClient): Promise<string> {
  const [row] = await client.$queryRaw<
    Array<{ system: string; database: string }>
  >`
    SELECT
      COALESCE(
        (SELECT "system_identifier"::text FROM "cluster_epoch" WHERE "id" = 1),
        (SELECT system_identifier::text FROM pg_control_system())
      ) AS system,
      current_database() AS database
  `;

  if (!row) throw new Error("the database did not say who it is");

  return `${row.system}/${row.database}`;
}

/** `run_id:` from `INFO server`; it changes when the Redis restarts. */
function redisRunIdFrom(info: string): string | null {
  const match = /^run_id:([0-9a-f]+)\s*$/m.exec(info);

  return match ? match[1] : null;
}

export {
  FINGERPRINT_LENGTH,
  FINGERPRINT_SETTINGS,
  configFingerprint,
  readDatabaseIdentity,
  redisRunIdFrom,
};
export type { FingerprintIdentities, FingerprintSettings };
