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
        unit_price: z.any(),
        registration_date: z.string(),
        businessId: z.string(),
        business_name: z.string(),
        supplierId: z.string().nullable(),
        supplierName: z.string().optional(),
        created_at: z.string(),
        updated_at: z.string(),
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
      .default("Esta peça já foi cadastrada para esta empresa!"),
  }),

  partInUse: z.object({
    message: z
      .string()
      .default(
        "Não é possível excluir esta peça pois ela está sendo usada em ordens de serviço.",
      ),
  }),

  // Grouping errors by route
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
        .default("Esta peça já foi cadastrada para esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este fornecedor não pertence a esta empresa!"),
    }),
  ]),

  listPartErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

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
        .default("Esta peça já foi cadastrada para esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta peça não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este fornecedor não pertence a esta empresa!"),
    }),
  ]),

  deletePartErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Peça não encontrada!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
    z.object({
      message: z.string().default("Esta peça não pertence a esta empresa!"),
    }),
  ]),
};

export { partSchemas, partResponses };
