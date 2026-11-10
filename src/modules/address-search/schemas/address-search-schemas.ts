import { z } from "zod";

import { UFS, type Uf } from "@/shared/brazil/uf-names";
import { BRAZIL_BOX } from "@/shared/delivery/address-coordinates";

/**
 * What the panel's address search takes (GET /address-search/:businessId):
 * the text typed, the delivery's city to search in and the box of the
 * route's stops to lean toward. The same rules the web applies before it
 * asks, so a request the page never sends is refused here too.
 */

/**
 * LocationIQ's own ceiling for the text searched — the text sent, the
 * delivery's city included (address-search-ranking.ts, scopedText).
 */
const ADDRESS_SEARCH_MAX_QUERY = 200;

const ADDRESS_SEARCH_MIN_QUERY = 3;

/**
 * The delivery's own ceiling (create-delivery-schema, `city`): the page
 * takes the hint from a delivery, and a city the API stored must never be
 * refused here. The web mirrors it (address-search-rules.ts).
 */
const ADDRESS_SEARCH_MAX_CITY = 100;

/** A box wider than this is no hint at all: half of a state. */
const VIEWBOX_MAX_SIDE_DEGREES = 10;

/** West, south, east, north: the order both providers read. */
type Viewbox = [number, number, number, number];

/** "  Rua   X " and "Rua X" are one search. */
function collapseSpaces(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function blankToUndefined(value: unknown): unknown {
  const collapsed = collapseSpaces(value);

  return collapsed === "" ? undefined : collapsed;
}

/** "w,s,e,n" as four numbers inside Brazil, or null for anything else. */
function parseViewbox(raw: string): Viewbox | null {
  const parts = raw.split(",").map((part) => Number(part.trim()));

  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const [west, south, east, north] = parts as Viewbox;

  const inside =
    west >= BRAZIL_BOX.minLng &&
    east <= BRAZIL_BOX.maxLng &&
    south >= BRAZIL_BOX.minLat &&
    north <= BRAZIL_BOX.maxLat;

  const ordered = west < east && south < north;

  const small =
    east - west <= VIEWBOX_MAX_SIDE_DEGREES &&
    north - south <= VIEWBOX_MAX_SIDE_DEGREES;

  return inside && ordered && small ? [west, south, east, north] : null;
}

const addressSearchQuerySchema = z
  .object({
    q: z
      .preprocess(
        collapseSpaces,
        z
          .string({ message: "Digite o endereço ou o lugar a buscar." })
          .min(ADDRESS_SEARCH_MIN_QUERY, {
            message: `Digite ao menos ${ADDRESS_SEARCH_MIN_QUERY} caracteres para buscar.`,
          })
          .max(ADDRESS_SEARCH_MAX_QUERY, {
            message: `A busca aceita até ${ADDRESS_SEARCH_MAX_QUERY} caracteres.`,
          }),
      )
      .describe(
        `O que foi digitado: rua e número, bairro ou o nome de um lugar (de ${ADDRESS_SEARCH_MIN_QUERY} a ${ADDRESS_SEARCH_MAX_QUERY} caracteres; espaços repetidos contam como um).`,
      ),
    city: z
      .preprocess(
        blankToUndefined,
        z
          .string({ message: "A cidade deve ser um texto." })
          .max(ADDRESS_SEARCH_MAX_CITY, {
            message: `A cidade aceita até ${ADDRESS_SEARCH_MAX_CITY} caracteres.`,
          })
          .optional(),
      )
      .describe(
        "A cidade da entrega, para buscar nela primeiro. Vai junto com `uf`, ou nenhuma das duas (busca no Brasil todo).",
      ),
    uf: z
      .preprocess(
        (value) =>
          typeof value === "string" && value.trim() !== ""
            ? value.trim().toUpperCase()
            : undefined,
        z
          .enum(UFS as [Uf, ...Uf[]], {
            message: "A UF deve ser uma das 27 siglas, como RJ ou SP.",
          })
          .optional(),
      )
      .describe("A UF da entrega (sigla). Vai junto com `city`."),
    viewbox: z
      .preprocess(
        blankToUndefined,
        z
          .string({ message: "A área do mapa deve ser um texto." })
          .optional()
          .refine((value) => value === undefined || !!parseViewbox(value), {
            message: `A área do mapa deve ser "oeste,sul,leste,norte" dentro do Brasil, com até ${VIEWBOX_MAX_SIDE_DEGREES}° de lado.`,
          }),
      )
      .describe(
        `A área das paradas da rota, "oeste,sul,leste,norte" em graus, dentro do Brasil e com até ${VIEWBOX_MAX_SIDE_DEGREES}° de lado: os resultados de perto vêm antes, os de longe não somem.`,
      ),
    limit: z.coerce
      .number({ message: "O limite deve ser um número." })
      .int({ message: "O limite deve ser um número inteiro." })
      .min(1, { message: "O limite vai de 1 a 10." })
      .max(10, { message: "O limite vai de 1 a 10." })
      .default(8)
      .describe("Quantas sugestões, de 1 a 10 (padrão 8)."),
  })
  .refine((query) => (query.city === undefined) === (query.uf === undefined), {
    message:
      "Informe a cidade e a UF juntas, ou nenhuma das duas para buscar no Brasil todo.",
  });

type AddressSearchQuery = z.infer<typeof addressSearchQuerySchema>;

export {
  ADDRESS_SEARCH_MAX_CITY,
  ADDRESS_SEARCH_MAX_QUERY,
  ADDRESS_SEARCH_MIN_QUERY,
  VIEWBOX_MAX_SIDE_DEGREES,
  addressSearchQuerySchema,
  parseViewbox,
};
export type { AddressSearchQuery, Viewbox };
