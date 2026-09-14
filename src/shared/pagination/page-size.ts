import { z } from "zod";

/**
 * How many rows one request may ask for, in one place.
 *
 * Every list in the app puts its `pageSize` straight into Prisma's `take`, so
 * the number a client sends is the number of rows the database builds, sorts
 * and serialises. Without a ceiling, `?pageSize=1000000` on any of the
 * nineteen offset-paginated endpoints is a single URL that asks one Postgres
 * backend to materialise a million rows and one Node process to hold them all
 * in memory — no authentication problem, no clever payload, just a number.
 *
 * 100 because that is what the cursor-paginated endpoints already enforce, and
 * because the panel's own picker stops at 50; the one caller that asks for
 * more is the chat thread list, at exactly 100. So the ceiling costs the
 * product nothing today and is the difference between a slow page and a
 * replica falling over at five million deliveries.
 *
 * Deliberately NOT relying on the frontend to stay within it: these are plain
 * query strings on an authenticated API, and the cheapest way to take the
 * service down should not be a number a browser sends.
 */
const MAX_PAGE_SIZE = 100;

/**
 * The `pageSize` field for an offset-paginated list.
 *
 * Keeps the existing coercion — `Number(val) || fallback`, so junk and zero
 * fall back to the default rather than failing the request — and adds the
 * ceiling above it. Changing the coercion is a separate decision: today a
 * malformed `pageSize` silently becomes the default, which is sloppy but is
 * also what every screen already depends on.
 */
function pageSizeField(fallback: number) {
  return z
    .string()
    .transform((val) => Number(val) || fallback)
    .refine(
      (num) => num >= 1 && num <= MAX_PAGE_SIZE,
      `A quantidade de itens por página deve estar entre 1 e ${MAX_PAGE_SIZE}.`,
    );
}

export { MAX_PAGE_SIZE, pageSizeField };
