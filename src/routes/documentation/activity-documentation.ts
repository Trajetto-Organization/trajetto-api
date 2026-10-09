import { listActivitiesSchema } from "@/schemas/list-activities-schema";

import { z } from "zod";

import { errorResponse, internalErrorResponse } from "./common-responses";
import { activitySummarySchema } from "@/schemas/activity-summary-schema";
import { cursorMeta } from "./ndjson";

const activitySchemas = {
  activitySummaryQuery: activitySummarySchema,
  createActivity: z.object({
    type: z.string().describe("Tipo da entidade relacionada"),
    action: z.string().describe("Ação realizada"),
    entityId: z.string().describe("ID da entidade"),
    description: z.string().describe("Descrição da atividade"),
    status: z.string().describe("Status relacionado à ação"),
  }),
  listAllActivitiesQuery: listActivitiesSchema,

  /**
   * Wire format only — plain strings, no transforms. The controller re-parses
   * with the real schema; declaring the coercion here as well would make
   * fastify hand the controller numbers where it expects strings.
   */
  listActivitiesCursorQuery: z.object({
    limit: z
      .string()
      .optional()
      .describe("Quantidade por página do feed (padrão 20, máximo 50)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última atividade recebida — uuid v7, ordenado no tempo"),
    search: z.string().optional().describe("Busca livre"),
    period: z
      .string()
      .optional()
      .describe("Janela do feed: 7d (padrão) ou 30d"),
    businessId: z
      .string()
      .optional()
      .describe("Somente MASTER: restringe o feed a uma empresa"),
  }),
};

/** One activity line, as the listings stream it (actor already presented). */
const activityRow = z.object({
  id: z.string(),
  type: z.string().describe("Tipo do registro (a entidade), do catálogo."),
  action: z.string().describe("create, update ou delete."),
  entityId: z.string(),
  description: z.string(),
  status: z
    .string()
    .describe("Status do catálogo, numa só grafia (a gravação normaliza)."),
  performedBy: z.string().nullable(),
  businessId: z.string().nullable(),
  tenantName: z.string().nullable().optional(),
  user: z
    .object({
      name: z.string(),
      email: z.string().nullable(),
      role: z
        .string()
        .describe(
          "MASTER, BUSINESS_ADMIN, BUSINESS_USER, DRIVER (motorista pelo app) ou PLATFORM (a equipe Trajetto, para quem não é MASTER).",
        ),
    })
    .nullable()
    .optional(),
  business: z.object({ corporate_reason: z.string() }).nullable().optional(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

/** An error body with the `code` a client branches on (decision 11.3). */
const codedError = (description: string) =>
  z
    .object({
      code: z.string().optional(),
      message: z.string(),
      issues: z.array(z.string()).optional(),
    })
    .describe(description);

const activityResponses = {
  activityRow,
  listActivitiesErrors: codedError(
    "VALIDATION_ERROR: filtro ou ordenação inválidos (status, tipo, ação ou papel fora do catálogo; `sort` diferente de created_at).",
  ),
  activityForbidden: codedError(
    "PERMISSION_DENIED: só MASTER e administradores da empresa leem o registro de atividades.",
  ),
  activitySummary: z.object({
    data: z.object({
      total: z.number().describe("Ações registradas no período."),
      created: z.number(),
      updated: z.number(),
      deleted: z.number().describe("Exclusões — o número que um gestor olha."),
      activeUsers: z.number().describe("Usuários distintos que agiram."),
      topType: z.string().nullable().describe("Módulo mais movimentado."),
      topTypeCount: z.number(),
      periodDays: z.number(),
    }),
  }),
  // The cursor feed sends no total at all, and says which window it read.
  activityCursorMeta: cursorMeta(
    {
      periodDays: z
        .number()
        .describe("A janela consultada, em dias (7 ou 30)."),
    },
    null,
  ),
  internalServerError: internalErrorResponse,
  resourceNotFound: errorResponse,
};

export { activitySchemas, activityResponses };
