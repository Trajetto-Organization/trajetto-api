import { z } from "zod";

/**
 * Server-side sort and facet filters for offset listings (decision 8.8).
 *
 * The web table used to sort and filter only the rows of the page it had
 * loaded, so "Impeditivas" listed the blocking ones among ten rows while the
 * pager still said "Página 1 de 40". A listing now takes `sort`, `order` and
 * one query param per facet; each is validated here against what that list
 * declares, and the repository turns it into its `orderBy`/`where`.
 *
 * Wire format, mirrored by the web (tanstack-table/data-table/server-table.ts):
 *   ?sort=<key>&order=asc|desc&<facet>=<v1>,<v2>
 * A facet also accepts the repeated form (`?status=A&status=B`).
 */

const SORT_ORDERS = ["asc", "desc"] as const;

type SortOrder = (typeof SORT_ORDERS)[number];

/** Each facet value becomes a term of an IN list; a URL is not a bulk API. */
const MAX_FACET_VALUES = 50;

type Keys = readonly [string, ...string[]];

/** `sort` and `order`, validated against the keys this list can order by. */
function sortFields<const K extends Keys>(
  keys: K,
  fallback: { sort: K[number]; order: SortOrder },
) {
  const allowed = keys.join(", ");

  return {
    sort: z
      .enum(keys as unknown as [K[number], ...K[number][]], {
        errorMap: () => ({
          message: `Ordenação inválida. Use uma destas colunas: ${allowed}.`,
        }),
      })
      .optional()
      .describe(
        `Coluna da ordenação: ${allowed}. Ausente, ${fallback.sort} ${fallback.order}.`,
      ),
    order: z
      .enum(SORT_ORDERS, {
        errorMap: () => ({
          message: "A direção da ordenação deve ser asc ou desc.",
        }),
      })
      .optional()
      .describe(
        "asc ou desc. Com `sort` informado e sem `order`, asc. Sem nenhum dos dois, a ordem padrão.",
      ),
  };
}

/**
 * Splits a facet param into distinct, trimmed values.
 *
 * Accepts the repeated form too: Fastify hands `?a=1&a=2` over as an array,
 * and refusing it would make a hand-written URL fail for a formatting choice.
 */
function facetValues(raw: unknown): string[] | undefined {
  const joined = Array.isArray(raw) ? raw.join(",") : raw;

  if (typeof joined !== "string") return undefined;

  const values = Array.from(
    new Set(
      joined
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  return values.length > 0 ? values : undefined;
}

function checkFacetSize(values: string[], ctx: z.RefinementCtx): boolean {
  if (values.length <= MAX_FACET_VALUES) return true;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Filtro com valores demais: no máximo ${MAX_FACET_VALUES}.`,
  });

  return false;
}

// Arrays pass the string check as their comma-joined form (see facetValues).
const facetInput = z.preprocess(
  (raw) => (Array.isArray(raw) ? raw.join(",") : raw),
  z.string().optional(),
);

/** A facet over a closed set of values (a status, a severity). */
function facetField<const V extends Keys>(values: V, description: string) {
  const allowed = values.join(", ");

  return facetInput
    .transform((raw, ctx): V[number][] | undefined => {
      const list = facetValues(raw);

      if (!list) return undefined;
      if (!checkFacetSize(list, ctx)) return z.NEVER;

      const unknown = list.find((value) => !values.includes(value));

      if (unknown !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Valor de filtro inválido: "${unknown}". Use: ${allowed}.`,
        });

        return z.NEVER;
      }

      return list as V[number][];
    })
    .describe(`${description} Um ou mais valores separados por vírgula: ${allowed}.`);
}

const uuid = z.string().uuid();

/** A facet over records of a catalog (a type, a shipper), by id. */
function idFacetField(description: string) {
  return facetInput
    .transform((raw, ctx): string[] | undefined => {
      const list = facetValues(raw);

      if (!list) return undefined;
      if (!checkFacetSize(list, ctx)) return z.NEVER;

      if (list.some((value) => !uuid.safeParse(value).success)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Filtro com identificador inválido.",
        });

        return z.NEVER;
      }

      return list;
    })
    .describe(
      `${description} Um ou mais IDs separados por vírgula (até ${MAX_FACET_VALUES}).`,
    );
}

/**
 * How one list orders: the public keys and the `orderBy` each one means.
 *
 * `tiebreaker` is appended to every order so rows with equal values keep one
 * order between two requests: offset paging over an unstable order repeats
 * some rows and skips others when the page turns.
 */
interface SortSpec<K extends string, TOrderBy> {
  keys: readonly [K, ...K[]];
  fallback: { sort: K; order: SortOrder };
  columns: Record<K, (order: SortOrder) => TOrderBy>;
  tiebreaker: readonly TOrderBy[];
}

function firstKey(entry: unknown): string | undefined {
  return entry && typeof entry === "object" ? Object.keys(entry)[0] : undefined;
}

function resolveOrderBy<K extends string, TOrderBy>(
  spec: SortSpec<K, TOrderBy>,
  input: { sort?: K; order?: SortOrder },
): TOrderBy[] {
  const sort = input.sort ?? spec.fallback.sort;
  const order = input.order ?? (input.sort ? "asc" : spec.fallback.order);

  const primary = spec.columns[sort](order);
  const primaryKey = firstKey(primary);

  // A tiebreaker on the sorted column itself would only restate it.
  return [
    primary,
    ...spec.tiebreaker.filter((entry) => firstKey(entry) !== primaryKey),
  ];
}

export {
  MAX_FACET_VALUES,
  facetField,
  idFacetField,
  resolveOrderBy,
  sortFields,
  type SortOrder,
  type SortSpec,
};
