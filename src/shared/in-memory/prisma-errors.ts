import { Prisma } from "@prisma/client";

/**
 * The errors Prisma raises, as the in-memory twins must raise them
 * (decision 13.2). A twin that answered a missing row with
 * `splice(findIndex(...))` deleted the LAST row (index -1), and one that
 * accepted a duplicate let a use case's P2002 branch go untested.
 */

type MissingRowOperation = "update" | "delete";

const NOT_FOUND_MESSAGE: Record<MissingRowOperation, string> = {
  update: "Record to update not found.",
  delete: "Record to delete does not exist.",
};

/** P2025: what `update`/`delete` raise when the `where` matches no row. */
function recordNotFound(
  operation: MissingRowOperation = "update",
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    NOT_FOUND_MESSAGE[operation],
    {
      code: "P2025",
      clientVersion: "in-memory",
    },
  );
}

/** P2002 with `meta.target` naming the columns, as Postgres' unique index does. */
function uniqueViolation(
  target: string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.map((field) => `\`${field}\``).join(",")})`,
    { code: "P2002", clientVersion: "in-memory", meta: { target } },
  );
}

/**
 * The index of the row an `update`/`delete` targets, or P2025 — never -1,
 * which `splice` and `array[index] =` silently accept.
 */
function requireIndex<T>(
  rows: T[],
  matches: (row: T) => boolean,
  operation: MissingRowOperation = "update",
): number {
  const index = rows.findIndex(matches);

  if (index === -1) throw recordNotFound(operation);

  return index;
}

/** Throws P2002 when another row already holds the same non-null value. */
function assertUniqueValue<T extends { id?: string | null }>(
  rows: T[],
  candidate: T,
  column: keyof T & string,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {},
): void {
  const value = candidate[column];

  // Postgres unique indexes allow any number of NULLs.
  if (value === null || value === undefined) return;

  const normalise = (raw: unknown) =>
    caseInsensitive && typeof raw === "string" ? raw.toLowerCase() : raw;

  const taken = rows.some(
    (row) =>
      row.id !== candidate.id && normalise(row[column]) === normalise(value),
  );

  if (taken) throw uniqueViolation([column]);
}

export { assertUniqueValue, recordNotFound, requireIndex, uniqueViolation };
