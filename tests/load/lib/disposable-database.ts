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

/**
 * The seed's second check (plano-escala LOAD-02): is the database EMPTY?
 *
 * The port says where the connection goes, not what is there. The prod-like
 * rung reaches its Database through a tunnel on LOAD_PG_PORT, on the same
 * server as production's, and a tunnel to the wrong one passes the port
 * check. With LOAD_TIER the seed then drops the secondary indexes of the
 * hot tables (05-indexes-off.sql) and loads millions of rows with the
 * foreign keys unchecked (session_replication_role = replica). So the seed
 * also refuses a database holding any company it did not write itself: a
 * freshly migrated one has none, production always has some.
 *
 * Counted up to a cap: the answer is "any", and the count is only for the
 * message.
 */
const FOREIGN_COMPANIES_CAP = 100;

const SEED_TARGET_SQL = `
  SELECT
    current_database() AS "database",
    (SELECT count(*)::int FROM (
       SELECT 1 FROM "business"
       WHERE "id" IS DISTINCT FROM $1::text
       LIMIT ${FOREIGN_COMPANIES_CAP}
     ) AS foreign_company) AS "foreignCompanies"
`;

interface SeedTarget {
  database: string;
  /** Companies other than the seed's own, up to FOREIGN_COMPANIES_CAP. */
  foreignCompanies: number;
}

/** Null when the seed may write; otherwise why not, in pt-BR. */
function seedTargetRefusal(target: SeedTarget): string | null {
  if (target.foreignCompanies === 0) return null;

  const count =
    target.foreignCompanies >= FOREIGN_COMPANIES_CAP
      ? `${FOREIGN_COMPANIES_CAP} ou mais empresas`
      : target.foreignCompanies === 1
        ? "1 empresa"
        : `${target.foreignCompanies} empresas`;

  return (
    `O banco "${target.database}" já tem ${count} que este seed não criou. ` +
    "O seed só escreve num banco vazio, recém-migrado: com LOAD_TIER ele " +
    "tira os índices das tabelas grandes e desliga a conferência das chaves " +
    "estrangeiras. Confira para onde vai o DATABASE_URL (e o túnel da " +
    "LOAD_PG_PORT) ou recrie o banco."
  );
}

/** Runs one query with positional values and returns its rows. */
type RowsQuery = (sql: string, values: unknown[]) => Promise<unknown[]>;

/**
 * Throws unless the database the query reaches has no company besides
 * `ownCompanyId` (the tenant this run already wrote, or none yet).
 */
async function assertSeedTargetEmpty(
  query: RowsQuery,
  ownCompanyId: string | null = null,
): Promise<void> {
  const [target] = (await query(SEED_TARGET_SQL, [ownCompanyId])) as [
    SeedTarget,
  ];
  const refusal = seedTargetRefusal(target);

  if (refusal) throw new Error(refusal);
}

export {
  assertDisposableDatabase,
  assertSeedTargetEmpty,
  disposableDatabaseRefusal,
  seedTargetRefusal,
};
export type { SeedTarget };
