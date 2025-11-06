import { z } from "zod";

import { runSimulationSchema } from "@/schemas/run-simulation-schema";

import { createSimulationSchema } from "@/schemas/create-simulation-schema";
import { updateSimulationSchema } from "@/schemas/update-simulation-schema";

import { simulationIdSchema } from "@/schemas/simulation-id-schema";
import { listSimulationsQuerySchema } from "@/schemas/list-simulations-query-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const simulationSchemas = {
  runSimulation: runSimulationSchema,
  createSimulation: createSimulationSchema,
  updateSimulation: updateSimulationSchema,
  listSimulationsQuery: listSimulationsQuerySchema,
  businessIdParam: updateDeleteBusinessSchema,
  simulationIdParam: simulationIdSchema,
};

const simulationResponses = {
  simulationRunCompleted: z.object({
    message: z.string().default("Simulação processada com sucesso!"),
    simulation: z.any(),
    status: z.literal("completed"),
  }),

  simulationProcessing: z.object({
    message: z.string(),
    simulation: z.any(),
    status: z.literal("processing"),
  }),

  simulationCreated: z.object({
    message: z.string().default("Simulação criada com sucesso!"),
    simulation: z.any(),
  }),

  simulationList: z.object({
    data: z.array(z.any()),
    total: z.number(),
  }),

  simulationUpdated: z.object({
    message: z.string().default("Simulação atualizada com sucesso!"),
  }),

  simulationDeleted: z.object({
    message: z.string().default("Simulação deletada com sucesso!"),
  }),

  simulationApproved: z.object({
    message: z.string().default("Simulação aprovada e rotas criadas com sucesso!"),
    routesCreated: z.number(),
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

  simulationNotFound: z.object({
    message: z.string().default("Simulação não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  // Grouping errors by route
  createSimulationErrors: z.union([
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
          "Houve um erro ao tentar criar a simulação! Por favor, tente novamente.",
        ),
    }),
  ]),

  listSimulationsErrors: z.union([
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
          "Houve um erro ao tentar listar as simulações! Por favor, tente novamente.",
        ),
    }),
  ]),

  getSimulationErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Simulação não encontrada!"),
    }),
    z.object({
      message: z.string().default("Sem permissão para acessar esta simulação!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar buscar a simulação! Por favor, tente novamente.",
        ),
    }),
  ]),

  updateSimulationErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Simulação não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Sem permissão para atualizar esta simulação!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar atualizar a simulação! Por favor, tente novamente.",
        ),
    }),
  ]),

  deleteSimulationErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Simulação não encontrada!"),
    }),
    z.object({
      message: z.string().default("Sem permissão para deletar esta simulação!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar deletar a simulação! Por favor, tente novamente.",
        ),
    }),
  ]),

  approveSimulationErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Simulação não encontrada!"),
    }),
    z.object({
      message: z.string().default("Sem permissão para aprovar esta simulação!"),
    }),
    z.object({
      message: z.string().default("Apenas simulações concluídas podem ser aprovadas!"),
    }),
    z.object({
      message: z.string().default("Esta simulação não possui resultados para aprovar!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar aprovar a simulação! Por favor, tente novamente.",
        ),
    }),
  ]),

  runSimulationErrors: z.union([
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
        .default("É necessário fornecer ao menos uma rota para simular!"),
    }),
    z.object({
      message: z.string().default("Erro ao processar simulação!"),
    }),
    z.object({
      message: z.string().default("Erro ao enfileirar simulação!"),
    }),
  ]),
};

export { simulationSchemas, simulationResponses };
