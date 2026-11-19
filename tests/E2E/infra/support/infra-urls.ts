/**
 * The connections of the E2E infra phase (plano-escala F4-38): a real
 * PgBouncer and a real streaming standby, on a stack of their own that
 * tests/E2E/infra/run.sh (`yarn test:e2e:infra`) starts, exports here and
 * removes at the end.
 *
 * A missing URL FAILS the file, it never skips it. A `skipIf` would turn
 * the CI's infra phase green with nothing tested the day the workflow
 * stopped starting the stack, and that phase is the only proof that the
 * pool, the auth_query and the standby work as the code assumes.
 *
 * Every URL must point at the loopback, and never at the shared test
 * cluster (TEST_DATABASE_URL or DATABASE_URL): the phase gives roles a
 * login and a password and holds a replication slot, which belong to the
 * whole cluster, so it runs on the stack's own primary and nowhere else.
 */
const INFRA_URL_VARIABLES = {
  /** The stack's primary, as its superuser (the Database's user). */
  primary: "E2E_INFRA_PRIMARY_URL",
  /** The streaming standby of that primary, as the same superuser. */
  standby: "E2E_INFRA_STANDBY_URL",
  /** The runtime through the PgBouncer: trajetto_http on the database. */
  pgbouncer: "E2E_INFRA_PGBOUNCER_URL",
  /** The PgBouncer console as pgbouncer_stats (SHOW only). */
  pgbouncerStats: "E2E_INFRA_PGBOUNCER_STATS_URL",
} as const;

type InfraEndpoint = keyof typeof INFRA_URL_VARIABLES;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `host:port` of a Postgres URL, the port 5432 when it has none. */
function addressOf(url: URL): string {
  return `${url.hostname}:${url.port || "5432"}`;
}

/** The shared test cluster's address, or null when none is configured. */
function sharedCluster(env: NodeJS.ProcessEnv): string | null {
  const configured = env.TEST_DATABASE_URL || env.DATABASE_URL;

  if (!configured) return null;

  try {
    return addressOf(new URL(configured));
  } catch {
    return null;
  }
}

/** The URL of one endpoint of the stack, or an error saying what is wrong. */
function infraUrl(
  endpoint: InfraEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = INFRA_URL_VARIABLES[endpoint];
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} não está definida. A fase infra do E2E roda na pilha própria ` +
        "dela (PgBouncer e standby reais): yarn test:e2e:infra " +
        "(tests/E2E/infra/run.sh), que sobe a pilha e define as URLs. " +
        "Sem a URL o arquivo falha, nunca é pulado (plano de escala F4-38).",
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} não é uma URL válida.`);
  }

  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(
      `${name} aponta para ${url.hostname}: a fase infra só roda contra a ` +
        "pilha descartável da própria máquina (127.0.0.1), nunca contra um " +
        "servidor de verdade.",
    );
  }

  if (addressOf(url) === sharedCluster(env)) {
    throw new Error(
      `${name} aponta para o cluster de teste compartilhado ` +
        `(${addressOf(url)}): a fase infra mexe em logins e em replicação, ` +
        "que são do cluster inteiro, e roda só no primário da própria pilha.",
    );
  }

  return value;
}

export { INFRA_URL_VARIABLES, infraUrl };
export type { InfraEndpoint };
