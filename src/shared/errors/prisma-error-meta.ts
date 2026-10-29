/**
 * What a Prisma error says about the database's own answer, under Prisma 7.
 *
 * Prisma 6's Rust engine put the details in `meta`: the columns or index of a
 * unique violation in `meta.target`, a raw query's SQLSTATE in `meta.code`.
 * Prisma 7 hands over the driver adapter's error instead, as
 * `meta.driverAdapterError.cause`: `{ kind, originalCode, constraint }`. A
 * unique violation names the INDEX there (`constraint.index`), or the columns
 * (`constraint.fields`) when Postgres gave no constraint name.
 *
 * Both spellings are read, so an error built by hand (the in-memory twins,
 * tests) and one from Postgres take the same path.
 */

interface DriverAdapterCause {
  /** `UniqueConstraintViolation`, `DatabaseNotReachable`, `postgres`… */
  kind?: string;

  /** Postgres' SQLSTATE (`23505`, `57P01`…), when Postgres answered. */
  originalCode?: string;

  /** Same, for the generic `postgres` kind. */
  code?: string;

  constraint?: { fields?: unknown; index?: unknown };
}

function metaOf(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const meta = (error as { meta?: unknown }).meta;

  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : undefined;
}

/** `meta.driverAdapterError.cause` of a Prisma 7 error, if any. */
function driverAdapterCauseOf(error: unknown): DriverAdapterCause | undefined {
  const adapterError = metaOf(error)?.driverAdapterError;

  if (typeof adapterError !== "object" || adapterError === null) {
    return undefined;
  }

  const cause = (adapterError as { cause?: unknown }).cause;

  return typeof cause === "object" && cause !== null
    ? (cause as DriverAdapterCause)
    : undefined;
}

/**
 * The unique key a P2002 names: the columns (an array) or the index name (a
 * string), as `meta.target` used to be. Undefined when the error names none.
 *
 * Under Prisma 7 it is usually the index name — `driver_businessId_cpf_key`
 * for an `@@unique`, the raw name for an index created in SQL — so callers
 * match on a fragment of it (the column), never on the whole value.
 */
function uniqueTargetOf(error: unknown): string[] | string | undefined {
  const target = metaOf(error)?.target;

  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return target;

  const constraint = driverAdapterCauseOf(error)?.constraint;

  if (Array.isArray(constraint?.fields)) return constraint.fields.map(String);
  if (typeof constraint?.index === "string") return constraint.index;

  return undefined;
}

/** Postgres' SQLSTATE behind a failed query, under either Prisma version. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = driverAdapterCauseOf(error);
  const code = cause?.originalCode ?? cause?.code ?? metaOf(error)?.code;

  return typeof code === "string" && code !== "N/A" ? code : undefined;
}

export { driverAdapterCauseOf, sqlStateOf, uniqueTargetOf };
export type { DriverAdapterCause };
