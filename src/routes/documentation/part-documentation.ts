import { z } from "zod";

import { createPartSchema } from "@/schemas/create-part-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { updatePartSchema } from "@/schemas/update-part-schema";

const partBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  partId: z.string().uuid("O ID da peça é obrigatório!"),
});

const partSchemas = {
  createPart: createPartSchema,
  listPart: listPagesSchema,
  listPartBusinessSchema: listPagesByBusinessSchema,
  updatePart: updatePartSchema,
  businessIdParam: updateDeleteBusinessSchema,
  partBusinessParams: partBusinessParams,
  searchPartCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de peças a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última peça da página anterior para paginação"),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const partResponses = {
  partCreated: z.object({
    message: z.string().default("Peça criada com sucesso!"),
  }),

  partList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        unit_price: z.union([z.string(), z.number()]),
        businessId: z.string().optional(),
        supplierId: z.string().nullable().optional(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        supplier: z
          .object({
            name: z.string(),
          })
          .nullable()
          .optional(),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .nullable()
          .optional(),
      }),
    ),
    total: z.number(),
  }),

  partBusinessErrors: z.union([
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

  partUpdated: z.object({
    message: z.string().default("Peça atualizada com sucesso!"),
  }),

  partDeleted: z.object({
    message: z.string().default("Peça deletada com sucesso!"),
  }),

  searchPartStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are part objects.",
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

  partNotFound: z.object({
    message: z.string().default("Peça não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  supplierNotFound: z.object({
    message: z.string().default("Fornecedor não encontrado."),
  }),

  partAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Esta peça não está disponível para cadastro. Já existe uma peça com este nome.",
      ),
  }),

  // Grouping errors by route - CREATE (POST) - status 400
  createPartErrors: z.union([
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
      message: z.string().default("Fornecedor não encontrado."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Esta peça não está disponível para cadastro. Já existe uma peça com este nome.",
        ),
    }),
  ]),

  // Forbidden errors for CREATE (status 403)
  createPartForbiddenErrors: z.object({
    message: z.string().default("Este fornecedor não pertence a esta empresa!"),
  }),

  // LIST errors (GET) - status 400
  listPartErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  // UPDATE errors (PATCH) - status 400
  updatePartErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Peça não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Fornecedor não encontrado."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Esta peça não está disponível para cadastro. Já existe uma peça com este nome.",
        ),
    }),
  ]),

  // Forbidden errors for UPDATE (status 403)
  updatePartForbiddenErrors: z.union([
    z.object({
      message: z.string().default("Esta peça não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este fornecedor não pertence a esta empresa!"),
    }),
  ]),

  // DELETE errors (DELETE) - status 400
  deletePartErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Peça não encontrada!"),
    }),
  ]),

  // Forbidden errors for DELETE (status 403)
  deletePartForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Esta peça não pertence a esta ordem de serviço!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar esta peça pois ela está sendo utilizada em ordem(ns) de serviço.",
        ),
    }),
  ]),
};

export { partSchemas, partResponses };
