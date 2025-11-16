import { z } from "zod";

import { generateAnalyticsSchema } from "@/schemas/generate-analytics-schema";
import { analyticsIdSchema } from "@/schemas/analytics-id-schema";

import { listAnalyticsQuerySchema } from "@/schemas/list-analytics-query-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const fleetAnalyticsSchemas = {
  generateAnalytics: generateAnalyticsSchema,
  listAnalyticsQuery: listAnalyticsQuerySchema,
  businessIdParam: updateDeleteBusinessSchema,
  analyticsIdParam: analyticsIdSchema,
};

const fleetAnalyticsResponses = {
  analyticsProcessing: z.object({
    message: z
      .string()
      .default(
        "Análise enfileirada para processamento. Você receberá uma notificação quando estiver pronta.",
      ),
    analytics: z.any(),
    status: z.literal("processing"),
  }),

  analyticsDetail: z.object({
    analytics: z.any(),
  }),

  analyticsList: z.object({
    data: z.array(z.any()),
    total: z.number(),
  }),

  analyticsDeleted: z.object({
    message: z.string().default("Análise deletada com sucesso!"),
    analytics: z.any(),
  }),

  // Common Error Responses
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  validationError: z.object({
    message: z.string().default("Validation Error"),
    issues: z.array(z.string()),
  }),

  analyticsNotFound: z.object({
    message: z.string().default("Análise de frota não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  invalidAnalyticsType: z.object({
    message: z
      .string()
      .default(
        "Tipo de análise inválido! Tipos válidos: route_efficiency, cost_analysis, vehicle_utilization, fuel_consumption, maintenance_cost",
      ),
  }),

  invalidDateRange: z.object({
    message: z
      .string()
      .default(
        "Intervalo de datas inválido! A data final deve ser maior que a data inicial.",
      ),
  }),

  // Grouping errors by route
  generateAnalyticsErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Sem permissão para acessar esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Tipo de análise inválido! Tipos válidos: route_efficiency, cost_analysis, vehicle_utilization, fuel_consumption, maintenance_cost",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Intervalo de datas inválido! A data final deve ser maior que a data inicial.",
        ),
    }),
  ]),

  listAnalyticsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Sem permissão para acessar esta empresa!"),
    }),
  ]),

  getAnalyticsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Análise de frota não encontrada!"),
    }),
    z.object({
      message: z.string().default("Sem permissão para acessar esta análise!"),
    }),
  ]),

  deleteAnalyticsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Análise de frota não encontrada!"),
    }),
    z.object({
      message: z.string().default("Sem permissão para deletar esta análise!"),
    }),
  ]),
};

export { fleetAnalyticsSchemas, fleetAnalyticsResponses };
