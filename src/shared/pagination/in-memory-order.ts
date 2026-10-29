import type { SortOrder } from "./list-query";

/**
 * How Postgres orders a list, for the in-memory twins of a repository.
 *
 * A twin that orders its arrays differently from the `orderBy` the Prisma
 * repository sends proves nothing about the screen: the unit tests go green
 * while the real list shows another order. Every twin of a server-sorted
 * list (decision 8.8) compares through this one function, so NULLs, booleans
 * and dates land where Postgres puts them.
 */

type OrderValue = string | number | boolean | Date | null | undefined;

/**
 * Where NULLs go when the orderBy says so (Prisma's `{ sort, nulls }`).
 * Without it Postgres treats NULL as larger than any value: last on ASC,
 * first on DESC. That default is also what an optional relation gets
 * (`{ driver: { name: order } }`), since Prisma accepts `nulls` only on a
 * nullable scalar column.
 */
type NullsPlacement = "first" | "last";

function isNull(value: OrderValue): value is null | undefined {
  return value === null || value === undefined;
}

function comparable(
  value: Exclude<OrderValue, null | undefined>,
): string | number {
  if (value instanceof Date) return value.getTime();

  // false < true, as Postgres orders booleans.
  if (typeof value === "boolean") return value ? 1 : 0;

  return value;
}

/**
 * Two strings by Unicode code point.
 *
 * Every environment runs postgres:16-alpine, whose musl libc makes en_US.utf8
 * compare bytes, and UTF-8 byte order IS code point order: "ANA" < "Ana" <
 * "ana" < "bia" < "Ágata". JS `<` compares UTF-16 code units, which agrees
 * except for a character outside the BMP (an emoji) against U+E000–U+FFFF,
 * so the comparison walks code points instead.
 */
function compareCodePoints(a: string, b: string): number {
  let index = 0;

  while (index < a.length && index < b.length) {
    const left = a.codePointAt(index)!;
    const right = b.codePointAt(index)!;

    if (left !== right) return left < right ? -1 : 1;

    // Equal code points take the same number of units in both strings.
    index += left > 0xffff ? 2 : 1;
  }

  return Math.sign(a.length - index - (b.length - index));
}

/**
 * Negative when `a` comes first under `order`, positive when `b` does.
 *
 * Strings compare by code point, which is Postgres' order on the deployed
 * image (see compareCodePoints). A move to a glibc image changes the
 * database's order, and tests/E2E/driver-repository-contract and
 * catalog-repository-contract fail on purpose.
 */
function compareForOrder(
  a: OrderValue,
  b: OrderValue,
  order: SortOrder,
  nulls?: NullsPlacement,
): number {
  if (isNull(a) || isNull(b)) {
    if (isNull(a) && isNull(b)) return 0;

    const placement = nulls ?? (order === "asc" ? "last" : "first");
    const nullComesFirst = placement === "first" ? -1 : 1;

    return isNull(a) ? nullComesFirst : -nullComesFirst;
  }

  const left = comparable(a);
  const right = comparable(b);
  const base =
    typeof left === "string" && typeof right === "string"
      ? compareCodePoints(left, right)
      : left < right
        ? -1
        : left > right
          ? 1
          : 0;

  return order === "asc" ? base : -base;
}

export {
  compareCodePoints,
  compareForOrder,
  type NullsPlacement,
  type OrderValue,
};
