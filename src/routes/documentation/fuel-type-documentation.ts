import { z } from "zod";

import { createFuelTypeSchema } from "@/schemas/create-fuel-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateFuelTypeSchema } from "@/schemas/update-fuel-type-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const fuelTypeBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  fuelTypeId: z.string().uuid("O ID do tipo de combustível é obrigatório!"),
});

const fuelTypeSchemas = {
  createFuelType: createFuelTypeSchema,
  listFuelType: listPagesSchema,
  listFuelTypeBusiness: listPagesByBusinessSchema,
  updateFuelType: updateFuelTypeSchema,
  businessIdParam: updateDeleteBusinessSchema,
  fuelTypeBusinessParams: fuelTypeBusinessParams,
  searchFuelTypeCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de empresas a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última empresa da página anterior para paginação"),
    search: z.string().trim().max(100).optional(),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const fuelTypeResponses = {
  fuelTypeCreated: z.object({
    message: z.string().default("Tipo de combustível criado com sucesso!"),
  }),

  fuelTypeList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        businessId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
      }),
    ),
    total: z.number(),
  }),

  fuelTypeUpdated: z.object({
    message: z.string().default("Tipo de combustível atualizado com sucesso!"),
  }),

  fuelTypeDeleted: z.object({
    message: z.string().default("Tipo de combustível deletado com sucesso!"),
  }),

  searchFuelTypeStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are fuel type objects.",
      ),
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

  fuelTypeNotFound: z.object({
    message: z.string().default("Tipo de combustível não encontrado!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  fuelTypeAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este tipo de combustível não está disponível para cadastro. Já existe um tipo de combustível com este nome.",
      ),
  }),

  // Grouping errors by route
  createFuelTypeErrors: z.union([
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
      message: z
        .string()
        .default(
          "Este tipo de combustível não está disponível para cadastro. Já existe um tipo de combustível com este nome.",
        ),
    }),
  ]),

  listFuelTypeErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  listFuelTypeBusinessErrors: z.union([
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
  ]),

  updateFuelTypeErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este tipo de combustível não está disponível para cadastro. Já existe um tipo de combustível com este nome.",
        ),
    }),
  ]),

  updateFuelTypeForbiddenErrors: z.object({
    message: z
      .string()
      .default("Este tipo de combustível não pertence a esta empresa!"),
  }),

  deleteFuelTypeErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este tipo de combustível não pertence a esta empresa!"),
    }),
  ]),

  deleteFuelTypeForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar este tipo de combustível pois existem veículo(s) associado(s).",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar este tipo de combustível pois existem registro(s) de abastecimento associado(s).",
        ),
    }),
  ]),
};

export { fuelTypeSchemas, fuelTypeResponses };
