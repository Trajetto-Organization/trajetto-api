import { z } from "zod";

import { addressSearchQuerySchema } from "@/modules/address-search/schemas/address-search-schemas";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import {
  codedRefusal,
  errorResponse,
  internalErrorResponse,
} from "./common-responses";

/**
 * The panel's address search ("Fixar no mapa" on the route page, plan
 * pin-search). Geographic data from OpenStreetMap through the provider —
 * no company's records ever go in an answer.
 */

const suggestion = z.object({
  id: z.string().describe("O id do lugar no provedor."),
  title: z
    .string()
    .describe(
      'Como a lista mostra o lugar: "Rua Epitácio Pessoa, 120", "Hospital Santa Teresa", um bairro ou uma cidade.',
    ),
  subtitle: z
    .string()
    .describe(
      'O resto do endereço: "Centro, Petrópolis - RJ, 25610-000" (a rua e o número vêm aqui quando o título é o nome de um lugar).',
    ),
  latitude: z.number(),
  longitude: z.number(),
  precision: z
    .enum(["ADDRESS", "STREET", "PLACE", "NEIGHBORHOOD", "CITY"])
    .describe(
      "Até onde o ponto chegou: o número (ADDRESS), só a rua (STREET), um lugar com nome (PLACE), o bairro (NEIGHBORHOOD) ou a cidade (CITY). Bairro e cidade não são porta de cliente: a tela enquadra a área e pede o clique no mapa.",
    ),
  city: z.string().nullable(),
  uf: z.string().nullable().describe("A sigla da UF, quando o provedor diz."),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .nullable()
    .describe(
      "Sul, norte, oeste e leste da área de um bairro ou de uma cidade, para enquadrar no mapa. Null nos demais.",
    ),
  inScope: z
    .boolean()
    .describe("Na cidade e na UF pedidas. Sempre false numa busca sem cidade."),
});

const addressSearchSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  query: addressSearchQuerySchema,
};

const addressSearchResponses = {
  search: z.object({
    data: z.object({
      results: z
        .array(suggestion)
        .describe(
          "Do mais provável ao menos: a cidade pedida, depois a UF, o número e o nome digitados; bairro e cidade depois das ruas. Vazia quando nada foi encontrado.",
        ),
      weak: z
        .boolean()
        .describe(
          "Nenhum resultado tem um nome que foi digitado: o provedor não achou e respondeu outra coisa. A tela não pré-seleciona nenhum.",
        ),
      scope: z
        .enum(["CITY", "COUNTRY"])
        .describe(
          "CITY com `city` e `uf` (a busca foi feita nessa cidade); COUNTRY no Brasil todo.",
        ),
      cached: z
        .boolean()
        .describe(
          "A resposta veio do cache da empresa e não gastou busca do dia.",
        ),
    }),
  }),
  dailyLimit: codedRefusal(
    "ADDRESS_SEARCH_DAILY_LIMIT: acabaram as buscas de hoje (dia UTC) — as da empresa (`ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT`) ou as da plataforma (`ADDRESS_SEARCH_DAILY_BUDGET`). O `retry-after` vai até a meia-noite UTC. O clique no mapa continua funcionando.",
    ["ADDRESS_SEARCH_DAILY_LIMIT"],
  ),
  unavailable: codedRefusal(
    "ADDRESS_SEARCH_BUSY: a vaga do provedor está ocupada agora (a localização automática das entregas e as outras buscas dividem a mesma) ou ele pediu um intervalo; espere o `retry-after` e repita. ADDRESS_SEARCH_DISABLED: a busca está desligada na configuração da plataforma (sem `ADDRESS_SEARCH_URL` ou com `ADDRESS_SEARCH_DAILY_BUDGET=0`); não adianta repetir (`retry-after: 3600`), a tela vai direto ao clique no mapa. ADDRESS_SEARCH_UNAVAILABLE: a busca está pausada (o provedor recusou a chave ou a URL, ou a cota do dia do provedor acabou) ou o provedor falhou; o `retry-after` diz quando tentar de novo. Em todos os casos o clique no mapa continua funcionando, e o motivo fica só no log da API.",
    [
      "ADDRESS_SEARCH_BUSY",
      "ADDRESS_SEARCH_DISABLED",
      "ADDRESS_SEARCH_UNAVAILABLE",
    ],
  ),
  validation: errorResponse,
  internalServerError: internalErrorResponse,
};

export { addressSearchResponses, addressSearchSchemas };
