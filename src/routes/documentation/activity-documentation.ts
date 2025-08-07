import { listRecentActivitiesSchema } from "@/schemas/list-recent-activities-schema";
import { z } from "zod";

const activitySchemas = {
  createActivity: z.object({
    type: z.string().describe("Tipo da entidade relacionada"),
    action: z.string().describe("Ação realizada"),
    entityId: z.string().describe("ID da entidade"),
    description: z.string().describe("Descrição da atividade"),
    status: z.string().describe("Status relacionado à ação"),
  }),
  listActivitiesQuery: listRecentActivitiesSchema,
};

const activityResponses = {
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
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),
};

export { activitySchemas, activityResponses };
