import { z } from "zod";

import { createServiceOrderPartSchema } from "@/schemas/create-service-order-part-schema";
import { updateServiceOrderPartSchema } from "@/schemas/update-service-order-part-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";

const serviceOrderPartParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
  serviceOrderPartId: z
    .string()
    .uuid("O ID da peça de ordem de serviço é obrigatório!"),
});

const createServiceOrderPartParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
});

const serviceOrderPartSchemas = {
  createServiceOrderPart: createServiceOrderPartSchema,
  listServiceOrderPart: listPagesSchema,
  updateServiceOrderPart: updateServiceOrderPartSchema,
  serviceOrderPartParams: serviceOrderPartParams,
  createServiceOrderPartParams: createServiceOrderPartParams,
};

const serviceOrderPartResponses = {
  serviceOrderPartCreated: z.object({
    message: z
      .string()
      .default("Peça adicionada à ordem de serviço com sucesso!"),
  }),
  serviceOrderPartList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        unit_price: z.union([z.string(), z.number()]),
        quantity: z.number(),
        discount_percentage: z
          .union([z.string(), z.number()])
          .nullable()
          .optional(),
        businessId: z.string(),
        serviceOrderId: z.string(),
        partId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        part: z.object({
          id: z.string(),
          description: z.string(),
          unit_price: z.union([z.string(), z.number()]),
          businessId: z.string(),
          supplierId: z.string().nullable(),
          created_at: z.union([z.string(), z.date()]),
          updated_at: z.union([z.string(), z.date()]),
        }),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
        serviceOrder: z.object({
          id: z.string(),
          date: z.union([z.string(), z.date()]),
          vehicle: z.object({
            license_plate: z.string(),
            description: z.string(),
          }),
        }),
      }),
    ),
    total: z.number(),
  }),

  serviceOrderPartUpdated: z.object({
    message: z
      .string()
      .default("Peça da ordem de serviço atualizada com sucesso!"),
  }),

  serviceOrderPartDeleted: z.object({
    message: z
      .string()
      .default("Peça removida da ordem de serviço com sucesso!"),
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

  serviceOrderPartNotFound: z.object({
    message: z.string().default("Peça da ordem de serviço não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  serviceOrderNotFound: z.object({
    message: z.string().default("Ordem de serviço não encontrada!"),
  }),

  partNotFound: z.object({
    message: z.string().default("Peça não encontrada!"),
  }),

  serviceOrderPartAlreadyExists: z.object({
    message: z
      .string()
      .default("Esta peça já foi adicionada a esta ordem de serviço!"),
  }),

  // Grouping errors by route
  createServiceOrderPartErrors: z.union([
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
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z.string().default("Peça não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta peça já foi adicionada a esta ordem de serviço!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta peça não pertence a esta ordem de serviço!"),
    }),
  ]),

  createServiceOrderPartForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta peça não pertence a esta ordem de serviço!"),
    }),
  ]),

  listServiceOrderPartErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  updateServiceOrderPartErrors: z.union([
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
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z.string().default("Peça da ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z.string().default("Peça não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta peça já foi adicionada à ordem de serviço!"),
    }),
  ]),

  updateServiceOrderPartForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta peça não pertence a esta empresa!"),
    }),
  ]),

  deleteServiceOrderPartErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z.string().default("Peça da ordem de serviço não encontrada!"),
    }),
  ]),

  deleteServiceOrderPartForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta peça não pertence a esta ordem de serviço!"),
    }),
  ]),
};

export { serviceOrderPartSchemas, serviceOrderPartResponses };
