import { listRecentActivitiesSchema } from "@/schemas/list-recent-activities-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { z } from "zod";
import { activitySummarySchema } from "@/schemas/activity-summary-schema";

const activitySchemas = {
  activitySummaryQuery: activitySummarySchema,
  createActivity: z.object({
    type: z.string().describe("Tipo da entidade relacionada"),
    action: z.string().describe("Ação realizada"),
    entityId: z.string().describe("ID da entidade"),
    description: z.string().describe("Descrição da atividade"),
    status: z.string().describe("Status relacionado à ação"),
  }),
  listActivitiesQuery: listRecentActivitiesSchema,
  listAllActivitiesQuery: listPagesSchema,

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

const activityResponses = {
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
  activityCreated: z.object({
    message: z.string().default("Atividade registrada com sucesso"),
  }),
  activityList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        action: z.string(),
        entityId: z.string(),
        description: z.string(),
        status: z.string(),
        performedBy: z.string(),
        businessId: z.string().nullable(),
        userEmail: z.string().optional(),
        userName: z.string().optional(),
        userRole: z.string().optional(),
        business_name: z.string().optional(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),
  activityCursorStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line is the meta object {nextCursor, hasMore, periodDays}. Subsequent lines are activity objects, newest first.",
      ),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
};

export { activitySchemas, activityResponses };
