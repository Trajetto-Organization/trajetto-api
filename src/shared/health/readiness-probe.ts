import type { PrismaClient } from "@prisma/client";

import { createPrismaClient } from "@/shared/database/database-client";
import { runtimeApplicationName } from "@/shared/database/pool-config";
import { processRoleFromEnvironment } from "@/shared/lifecycle/process-role";

/**
 * The readiness probe's own database connection (OBS-11).
 *
 * Readiness used to run `SELECT 1` through the application's Prisma client —
 * the pool of `connection_limit` (10 in production) connections that every
 * request and worker of the replica shares, with a 20 s pool_timeout. When a
 * burst filled that pool the probe queued behind it; Traefik waits 5 s and
 * one failed probe takes the replica out of rotation. Under the same burst
 * both replicas left at once, so a slow minute became a total outage that
 * flapped every ten seconds.
 *
 * A dedicated connection measures what readiness is for — can this replica
 * reach a database that answers? — without competing for a slot. A saturated
 * main pool no longer takes the replica out; a database that is down or hung
 * still does, because a timeout here is a "no" and never a "yes".
 *
 * The cost is one more connection per replica: replicas × (connection_limit +
 * 1) + tooling must stay under max_connections (connection_limit is in the
 * production DATABASE_URL modelled in .env.example; replicas are a field of
 * the API Application in Dokploy).
 *
 * Behind PgBouncer (wave 17) a connection of its own in the API is not
 * enough: the probe's statement would wait in PgBouncer's pool with every
 * request, and a saturated pool would take every replica out at once
 * (query_wait_timeout) — the outage OBS-11 removed, one hop further. The
 * trajetto-pgbouncer image has a `<db>_probe` alias, a pool of 2 server
 * connections of its own to the same database (infra/pgbouncer), and
 * READINESS_DATABASE_URL points the probe there (plano-escala F4-37).
 * Postgres down is still a "no": the alias reaches the same database.
 * Unset, the probe uses DATABASE_URL, as before.
 */

/** Answer or give up well inside Traefik's 5 s health-check timeout. */
const READINESS_TIMEOUT_MS = 3_000;

/**
 * The production URL with the probe's own pool settings: one connection, a
 * short wait for it, a short connect and a short query. Everything else —
 * the host, the schema, the statement/lock timeouts in `options` — is kept.
 * The URL goes through the same mapping as the app's (pool-config.ts), so
 * under Prisma 7 these become pg's `max: 1`, 2 s to get the connection and a
 * 3 s `query_timeout`. pool_timeout's 2 s covers both the wait and the
 * opening of a new connection, as it did under Prisma 6, so connect_timeout's
 * 3 s never comes into play: a host that does not answer is a "no" at 2 s.
 */
function probeUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);

  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  url.searchParams.set("connect_timeout", "3");
  url.searchParams.set("socket_timeout", "3");

  return url.toString();
}

/**
 * The URL the probe connects to: READINESS_DATABASE_URL (the PgBouncer
 * alias, plano-escala F4-37), else DATABASE_URL; empty counts as absent.
 * Read when the client is first built.
 */
function readinessDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const readiness = env.READINESS_DATABASE_URL?.trim();

  return readiness || env.DATABASE_URL || "";
}

/**
 * A client on the probe's own pool for that URL (probeUrl): one
 * connection, `trajetto-<role>-probe` in pg_stat_activity (plano-escala
 * F3-02).
 */
function createProbeClient(databaseUrl: string): PrismaClient {
  return createPrismaClient(
    {},
    {
      url: probeUrl(databaseUrl),
      overrides: {
        applicationName: runtimeApplicationName(
          processRoleFromEnvironment(process.env),
          "probe",
        ),
      },
    },
  ) as unknown as PrismaClient;
}

interface ProbeClient {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
}

let client: PrismaClient | null = null;

/** The close started by the last "no", while it runs. */
let reconnecting: Promise<void> | null = null;

/** Created on first use, so importing this module opens nothing. */
function probeClient(): PrismaClient {
  if (!client) client = createProbeClient(readinessDatabaseUrl());

  return client;
}

/**
 * Closes the probe's connection after a "no", so the next probe connects
 * afresh on the same client.
 *
 * The probe has ONE connection, and socket_timeout ends a query without
 * closing it. When that connection's peer vanished in silence (the database
 * task lost with its node, a partition), every later probe went out on the
 * same dead socket and the replica stayed "not ready" until the kernel gave
 * up on it (~15 min) — with the database back and answering (GAP6-5, GAP6-4).
 * Against a database that is really down, a fresh connection fails just the
 * same, so a "no" stays a "no".
 *
 * `$disconnect()`, not a new client: the next query reconnects the same
 * client. Under Prisma 6 a PrismaClient built per "no" kept ~2.3 MB of
 * native memory each (the image's musl engine): ~800 MB for an hour of
 * outage probed every 10 s, past the container's limit. Under Prisma 7 the
 * disconnect ends the probe's pg Pool and the next query builds another
 * (database-client.ts); pg already drops a connection whose query failed or
 * timed out, so this is now a second line, kept because it costs one pool
 * per "no" and nothing while ready. The close waits for the query still in
 * flight, which the 3 s query_timeout bounds.
 */
function reconnectProbeClient(): void {
  if (!client || reconnecting) return;

  reconnecting = client
    .$disconnect()
    .catch(() => {})
    .finally(() => {
      reconnecting = null;
    });
}

/**
 * Whether the database answers `SELECT 1` within `timeoutMs`. Never throws,
 * never waits longer: an error or a timeout is `false`.
 */
async function probeDatabase(
  timeoutMs: number = READINESS_TIMEOUT_MS,
  target?: ProbeClient,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  let ready = false;

  try {
    // Inside the try: a DATABASE_URL the URL parser refuses is a "no", not
    // an exception out of the readiness route.
    const probe = target ?? probeClient();
    const closing = target ? null : reconnecting;

    ready = await Promise.race([
      // After a "no", not on the connection being closed: the query goes out
      // once the close is done, on a new one — and only inside the timeout,
      // so a close that hangs is a "no" that queues nothing behind it.
      (closing ?? Promise.resolve()).then(() =>
        expired ? false : probe.$queryRaw`SELECT 1`.then(() => true),
      ),

      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } catch {
    ready = false;
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Only the module's own client: a target passed in belongs to the caller.
  if (!ready && !target) reconnectProbeClient();

  return ready;
}

export {
  READINESS_TIMEOUT_MS,
  createProbeClient,
  probeDatabase,
  probeUrl,
  readinessDatabaseUrl,
};
