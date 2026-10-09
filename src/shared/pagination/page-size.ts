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
      // Whole numbers only: 10.5 reached Prisma's `take` as a fraction.
      (num) => Number.isInteger(num) && num >= 1 && num <= MAX_PAGE_SIZE,
      `A quantidade de itens por página deve ser um número inteiro entre 1 e ${MAX_PAGE_SIZE}.`,
    )
    .describe(
      `Itens por página, inteiro de 1 a ${MAX_PAGE_SIZE}; vazio ou inválido vira ${fallback}.`,
    );
}

/**
 * The highest page an offset list answers. Keeps `(page - 1) * pageSize`
 * inside Prisma's 32-bit `skip` at the largest page size
 * (10^6 × 100 < 2^31); past it the value reached the database as a 500.
 */
const MAX_PAGE = 1_000_000;

/** The `page` field of an offset-paginated list, described once. */
const PAGE_DESCRIPTION =
  "Página pedida, inteiro de 1 a 1.000.000; vazio, zero ou não numérico vira 1; fração, negativo ou acima do limite: 400 VALIDATION_ERROR.";

/**
 * The `page` field. Same coercion as before for junk, empty and zero (they
 * fall back to 1, which every screen depends on); a fraction answered 200
 * with the fraction echoed in `meta` while Prisma coerced the offset.
 */
function pageField(description: string = PAGE_DESCRIPTION) {
  return z
    .string()
    .transform((val) => Number(val) || 1)
    .refine(
      (num) => Number.isInteger(num) && num >= 1 && num <= MAX_PAGE,
      "A página deve ser um número inteiro de 1 a 1.000.000.",
    )
    .describe(description);
}

export { MAX_PAGE, MAX_PAGE_SIZE, PAGE_DESCRIPTION, pageField, pageSizeField };
