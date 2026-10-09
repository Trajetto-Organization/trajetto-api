import { z } from "zod";

import { listTrafficViolationCodeSchema } from "@/schemas/list-traffic-violation-code-schema";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { errorResponse } from "./common-responses";

const trafficViolationCodeSchemas = {
  listTrafficViolationCode: listTrafficViolationCodeSchema,
  // The schema the controller parses, so the document names the real
  // `search` (it used to describe "empresas" and leave the term out).
  searchTrafficViolationCodeCursor: cursorPaginationSchema.extend({
    search: cursorPaginationSchema.shape.search.describe(
      "Código como impresso na notificação (`745` ou `745-50`) ou palavras da descrição; até 100 caracteres.",
    ),
  }),
};

const trafficViolationCodeRow = z.object({
  id: z.string().describe("ID do código."),
  code: z.string().describe("Código da infração."),
  sub_code: z.number().int().describe("Desdobramento."),
  description: z.string().describe("Descrição da infração."),
  legal_basis: z.string().describe("Amparo legal (CTB)."),
  violator_type: z.string().describe("Infrator (condutor, proprietário…)."),
  gravity: z
    .enum(["LIGHT", "MEDIUM", "SERIOUS", "VERY_SERIOUS", "NO_POINTS"])
    .describe("Gravidade."),
  gravity_raw: z.string().describe("Gravidade como na tabela de origem."),
  points: z.number().int().describe("Pontos na CNH."),
  competent_agency: z.string().describe("Órgão competente."),
  created_at: z.string().describe("Criação."),
  updated_at: z.string().describe("Última alteração."),
  gravityLabel: z.string().optional().describe("Gravidade em português."),
  fullCode: z.string().optional().describe("Código completo, ex.: 745-50."),
});

const trafficViolationCodeResponses = {
  trafficViolationCodeRow,
  error: errorResponse,
};

export { trafficViolationCodeSchemas, trafficViolationCodeResponses };
