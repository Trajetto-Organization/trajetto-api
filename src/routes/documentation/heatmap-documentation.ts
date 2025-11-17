import { z } from "zod";

import { generateHeatmapSchema } from "@/schemas/generate-heatmap-schema";

const heatmapSchemas = {
  generateHeatmap: generateHeatmapSchema,
};

const heatmapResponses = {
  heatmapProcessing: z.object({
    message: z
      .string()
      .default(
        "Heatmap enfileirado para processamento. Os dados serão gerados em breve.",
      ),
    heatmap: z.object({
      type: z.enum(["fines", "fuel", "maintenance"]),
      period: z.object({
        startDate: z.date(),
        endDate: z.date(),
      }),
      status: z.literal("processing"),
    }),
    status: z.literal("processing"),
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

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  invalidHeatmapType: z.object({
    message: z
      .string()
      .default(
        "Tipo de heatmap inválido! Valores permitidos: fines, fuel, maintenance.",
      ),
  }),

  invalidDateRange: z.object({
    message: z
      .string()
      .default(
        "Intervalo de datas inválido! A data final deve ser maior que a data inicial.",
      ),
  }),

  permissionDenied: z.object({
    message: z.string().default("Sem permissão para acessar esta empresa!"),
  }),

  // Grouping errors by route
  generateHeatmapErrors: z.union([
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
          "Tipo de heatmap inválido! Valores permitidos: fines, fuel, maintenance.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Intervalo de datas inválido! A data final deve ser maior que a data inicial.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Erro ao enfileirar heatmap. Tente novamente mais tarde."),
    }),
  ]),
};

export { heatmapSchemas, heatmapResponses };
