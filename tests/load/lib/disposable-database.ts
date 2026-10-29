/**
 * The one check every script under tests/load runs before it writes: is
 * DATABASE_URL the throwaway database of a test or load run, and not the
 * developer's?
 *
 * It used to be `DATABASE_URL.includes("54321")`, which had two holes. A URL
 * whose password or database name merely contained "54321" passed, and the
 * documented way to run the harness beside the shared test container
 * (compose.load.yaml publishes its Postgres on LOAD_PG_PORT when 54321 is
 * taken) could not be seeded at all: the seed refused the very port the
 * harness told the operator to use.
 *
 * Now the PORT is checked, on a loopback host: 54321, or the LOAD_PG_PORT the
 * operator set for the harness. 5432 is never accepted — that is where a
 * developer's own Postgres lives.
 */
const DISPOSABLE_PORT = 54321;
const DEVELOPER_PORT = 5432;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function allowedPorts(env: Record<string, string | undefined>): number[] {
  const ports = [DISPOSABLE_PORT];
  const harness = Number(env.LOAD_PG_PORT);

  if (Number.isInteger(harness) && harness > 0 && harness !== DEVELOPER_PORT) {
    ports.push(harness);
  }

  return ports;
}

/** Null when the URL may be written to; otherwise why not, in pt-BR. */
function disposableDatabaseRefusal(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const ports = allowedPorts(env);
  const expected = `porta ${ports.join(" ou ")} em localhost`;

  if (!url)
    return `DATABASE_URL não definida. Aponte para o banco descartável (${expected}).`;

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return `DATABASE_URL inválida. Aponte para o banco descartável (${expected}).`;
  }

  // An absent port is 5432, the developer's.
  const port = parsed.port ? Number(parsed.port) : DEVELOPER_PORT;

  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !ports.includes(port)) {
    return (
      `Só no banco descartável (${expected}); DATABASE_URL aponta para ` +
      `${parsed.hostname}:${port}. Para o Postgres do harness numa porta própria, ` +
      "defina LOAD_PG_PORT com a mesma porta do compose."
    );
  }

  return null;
}

function assertDisposableDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  env: Record<string, string | undefined> = process.env,
): void {
  const refusal = disposableDatabaseRefusal(url, env);

  if (refusal) throw new Error(refusal);
}

export { assertDisposableDatabase, disposableDatabaseRefusal };
