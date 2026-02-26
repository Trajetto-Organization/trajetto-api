import { listRecentActivitiesSchema } from "@/schemas/list-recent-activities-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

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
  listAllActivitiesQuery: listPagesSchema,
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
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
};

export { activitySchemas, activityResponses };
