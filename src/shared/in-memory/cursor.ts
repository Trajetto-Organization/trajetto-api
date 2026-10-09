import { compareForOrder } from "@/shared/pagination/in-memory-order";

/**
 * Prisma's `cursor: { id }, skip: 1` over an ordered list, for the twins.
 *
 * Prisma does not look the cursor up in the filtered list: it reads the
 * cursor ROW from the table (ignoring the `where`), keeps the filtered rows
 * that sort at or after it, and `skip: 1` then drops the first of those —
 * the cursor itself when it matches the `where`, otherwise a real row. A
 * cursor id with no row yields nothing. The twins used to ignore a cursor
 * they could not find in the filtered list, which restarted the list from
 * the top instead.
 *
 * `compare` must be the list's full order, tiebreakers included.
 */
function afterCursor<T extends { id?: string | null }>(
  ordered: T[],
  table: readonly T[],
  cursor: string | null | undefined,
  compare: (a: T, b: T) => number,
): T[] {
  if (!cursor) return ordered;

  const cursorRow = table.find((row) => row.id === cursor);

  if (!cursorRow) return [];

  return ordered.filter((row) => compare(row, cursorRow) >= 0).slice(1);
}

/** created_at desc, id desc: the order of every "newest first" picker. */
function newestFirst<
  T extends { created_at?: Date | string | null; id?: string | null },
>(a: T, b: T): number {
  const time = (row: T) =>
    row.created_at ? new Date(row.created_at).getTime() : null;

  return (
    compareForOrder(time(a), time(b), "desc") ||
    compareForOrder(a.id, b.id, "desc")
  );
}

/** name asc, id asc: the order of the name-sorted pickers. */
function byNameThenId<T extends { name: string; id?: string | null }>(
  a: T,
  b: T,
): number {
  return (
    compareForOrder(a.name, b.name, "asc") || compareForOrder(a.id, b.id, "asc")
  );
}

export { afterCursor, byNameThenId, newestFirst };
