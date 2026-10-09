/**
 * Case-insensitive EXACT matches that stay exact.
 *
 * On Postgres, Prisma compiles `{ equals: value, mode: "insensitive" }` to
 * `"column" ILIKE $1` and passes the value as the pattern, unescaped. So a `%`
 * or `_` inside it is a wildcard, not a character: a duplicate check for the
 * CNH "1%" found any CNH starting with 1, in any tenant, and its "not
 * available" answer let a caller read a stranger's document number back one
 * character at a time; "j_hn@..." matched "john@..." at the login.
 *
 * Backslash is Postgres' default LIKE escape character, so prefixing each
 * wildcard (and the backslash itself) makes the pattern match only the
 * literal text, still ignoring case.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The drop-in for `{ equals: value, mode: "insensitive" }` in a Prisma
 * `where`: the same case-insensitive equality, over the escaped value.
 */
function insensitiveEquals(value: string): {
  equals: string;
  mode: "insensitive";
} {
  return { equals: escapeLikePattern(value), mode: "insensitive" };
}

/** The Prisma string filters that compile to LIKE / ILIKE. */
const LIKE_FILTERS = new Set(["contains", "startsWith", "endsWith"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of a Prisma condition in which every `contains` / `startsWith` /
 * `endsWith` string is escaped, at any depth (relation filters, nested OR).
 *
 * Those filters are LIKE patterns too — `{ contains: term }` is
 * `LIKE '%' || term || '%'`, ILIKE with `mode: "insensitive"`, and Prisma does
 * not escape the term — so a list search for "50%" matched every row with a
 * "50" in it, and "%" or "_" alone matched every row. Only those three keys
 * are rewritten: `equals`, `in`, numbers, Dates and enums keep their value, so
 * a condition can be passed through whole. Hand it the RAW term; an already
 * escaped one would be escaped twice.
 */
function literalContains<T>(condition: T): T {
  if (Array.isArray(condition)) {
    return condition.map((item) => literalContains(item)) as T;
  }

  if (!isPlainObject(condition)) return condition;

  const copy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(condition)) {
    copy[key] =
      LIKE_FILTERS.has(key) && typeof value === "string"
        ? escapeLikePattern(value)
        : literalContains(value);
  }

  return copy as T;
}

export { escapeLikePattern, insensitiveEquals, literalContains };
