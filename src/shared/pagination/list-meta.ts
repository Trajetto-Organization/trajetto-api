import { z, type ZodRawShape } from "zod";

/**
 * What a listing tells its screen beyond the rows (decision 8.8).
 *
 * The NDJSON meta line of an offset listing is
 *   { meta: { total, page, pageSize, searchMeta } }
 * where `total` counts the rows of search + EVERY facet (it draws the pager)
 * and `searchMeta` carries the numbers of the cards plus, under `facets`, the
 * options each server-side filter offers with their counts.
 *
 * Cards and facet counts follow the disjunctive rule: a number broken down by
 * a facet is counted with every OTHER filter applied but not that facet.
 * Picking "Impeditiva" then narrows the table without turning the
 * "Informativas" card into a zero, and the popover still says how many each
 * option would bring. Counting over the loaded page is never acceptable.
 */

/** One option of a server-side facet: its value, how it reads and how many rows it brings. */
interface FacetCount {
  value: string;
  /** For catalog facets (a type's name); closed sets are labelled by the client. */
  label?: string;
  count: number;
}

/** The facets part of `searchMeta`, keyed by the facet's query param. */
type SearchMetaFacets<P extends string> = Record<P, FacetCount[]>;

const facetCountDoc = z.object({
  value: z.string().describe("O valor a enviar no parâmetro do filtro."),
  label: z
    .string()
    .optional()
    .describe("Rótulo do valor, quando vem de um cadastro (o nome do tipo)."),
  count: z
    .number()
    .int()
    .describe(
      "Quantos registros o valor traria, com os demais filtros aplicados.",
    ),
});

/**
 * Documents a listing's `searchMeta`: its card numbers and, per facet param,
 * the option list. Documentation only — the stream is not serialised by it.
 */
function searchMetaDoc<P extends string>(
  stats: ZodRawShape,
  facets: readonly P[],
) {
  const facetShape = Object.fromEntries(
    facets.map((param) => [param, z.array(facetCountDoc)]),
  ) as Record<P, z.ZodArray<typeof facetCountDoc>>;

  return z.object({
    ...stats,
    facets: z
      .object(facetShape)
      .describe(
        "Opções dos filtros do servidor, cada uma com a contagem que traria (os demais filtros aplicados, o próprio não).",
      ),
  });
}

/** Sum of the counts, for totals derived from a breakdown. */
function sumCounts(entries: ReadonlyArray<{ count: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

export { searchMetaDoc, sumCounts, type FacetCount, type SearchMetaFacets };
