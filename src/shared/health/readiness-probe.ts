import { PrismaClient } from "@prisma/client";

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
 * 1) + tooling must stay under max_connections (see compose.production.yaml).
 */

/** Answer or give up well inside Traefik's 5 s health-check timeout. */
const READINESS_TIMEOUT_MS = 3_000;

/**
 * The production URL with the probe's own pool settings: one connection, a
 * short wait for it, a short connect and a short query. Everything else —
 * the host, the schema, the statement/lock timeouts in `options` — is kept.
 */
function probeUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);

  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  url.searchParams.set("connect_timeout", "3");
  url.searchParams.set("socket_timeout", "3");

  return url.toString();
}

interface ProbeClient {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
}

let client: PrismaClient | null = null;

/** The close started by the last "no", while it runs. */
let reconnecting: Promise<void> | null = null;

/** Created on first use, so importing this module opens nothing. */
function probeClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasourceUrl: probeUrl(process.env.DATABASE_URL ?? ""),
    });
  }

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
 * engine. A PrismaClient built per "no" kept ~2.3 MB of native memory each
 * (the image's musl engine): ~800 MB for an hour of outage probed every
 * 10 s, past the container's limit. The close waits for the query still in
 * flight, which socket_timeout bounds; one stuck preparing a statement is
 * not bounded (docs/arquitetura.md (Conexão com o Postgres)), and until it ends the probe
 * says no.
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

export { READINESS_TIMEOUT_MS, probeDatabase, probeUrl };
