/**
 * Refuses to prepare an EMPTY production database without being told to.
 *
 * `trajetto-database` lives on a local volume. A task rescheduled on another
 * node, a removed volume, a renamed stack or a new Dokploy database all bring
 * Postgres back EMPTY — initdb, a healthy pg_isready, and a readiness that only
 * runs SELECT 1. The boot used to take that at face value: apply every
 * migration, create the MASTER user with the initial password and come up
 * "healthy" with zero tenants, taking new writes into a database that is not
 * the real one. That is a silent fork of the data; a visible outage is far
 * better.
 *
 * So in production a database with no applied migration stops the boot
 * before anything is migrated or seeded, unless ALLOW_EMPTY_DATABASE_BOOTSTRAP
 * says this really is a new installation. A restored database passes: the dump
 * carries `_prisma_migrations`.
 */

/** The part of a Prisma client this needs; a fake one in unit tests. */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface BootstrapFacts {
  nodeEnv: string | undefined;
  /** Rows of `_prisma_migrations` with finished_at set; 0 when the table is absent. */
  appliedMigrations: number;
  allowBootstrap: boolean;
}

export const EMPTY_DATABASE_REFUSAL =
  "Banco vazio em produção: nenhuma migration foi aplicada neste banco, e nada " +
  "foi migrado nem semeado. Se é uma instalação NOVA, rode a etapa de release " +
  "uma única vez com ALLOW_EMPTY_DATABASE_BOOTSTRAP=true na Application " +
  "trajetto-api-migrate (na API, nunca). Se não é, o banco que respondeu NÃO é o " +
  "de produção — volume novo, stack renomeada ou a task do Postgres reagendada " +
  "em outro nó (o volume é local). Restaure o dump antes de subir a API: " +
  "docs/deploy.md (Backup e restauração).";

/** Pure decision: the refusal message, or null to go ahead. */
export function freshDatabaseRefusal(facts: BootstrapFacts): string | null {
  if (facts.nodeEnv !== "production") return null;
  if (facts.allowBootstrap) return null;
  if (facts.appliedMigrations > 0) return null;

  return EMPTY_DATABASE_REFUSAL;
}

/**
 * Asks the database how many migrations it has applied, but only when the
 * answer can change the outcome: outside production, or with the bootstrap
 * flag set, nothing is queried.
 */
export async function emptyDatabaseRefusal(
  client: RawQueryClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const nodeEnv = env.NODE_ENV;
  const allowBootstrap = env.ALLOW_EMPTY_DATABASE_BOOTSTRAP === "true";

  if (nodeEnv !== "production" || allowBootstrap) return null;

  // Two statements: a query that names a missing table fails at parse time,
  // even behind a CASE. current_schema() is the `schema` of the URL.
  const [table] = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass(format('%I._prisma_migrations', current_schema())) IS NOT NULL AS present`,
  );

  let appliedMigrations = 0;

  if (table?.present) {
    const [row] = await client.$queryRawUnsafe<Array<{ applied: number }>>(
      `SELECT count(*)::int AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );

    appliedMigrations = Number(row?.applied ?? 0);
  }

  return freshDatabaseRefusal({ nodeEnv, appliedMigrations, allowBootstrap });
}
