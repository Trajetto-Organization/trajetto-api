import { z } from "zod";

import { createServiceOrderSchema } from "@/schemas/create-service-order-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateServiceOrderSchema } from "@/schemas/update-service-order-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const serviceOrderBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
});

const serviceOrderSchemas = {
  createServiceOrder: createServiceOrderSchema,
  listServiceOrder: listPagesSchema,
  listServiceOrderBusinessSchema: listPagesByBusinessSchema,
  updateServiceOrder: updateServiceOrderSchema,
  businessIdParam: updateDeleteBusinessSchema,
  serviceOrderBusinessParams: serviceOrderBusinessParams,
};

const serviceOrderResponses = {
  serviceOrderCreated: z.object({
    message: z.string().default("Ordem de serviço criada com sucesso!"),
  }),

  serviceOrderList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        date: z.string(),
        completion_date: z.string().nullable(),
        maintenance_type: z.enum(["INTERNAL", "EXTERNAL"]),
        total_amount: z.string(),
        businessId: z.string(),
        vehicleId: z.string(),
        vehicleLicensePlate: z.string(),
        vehicleDescription: z.string(),
        responsibleUserId: z.string(),
        responsibleUserName: z.string(),
        branchId: z.string(),
        branchName: z.string(),
        supplierId: z.string().nullable(),
        supplierName: z.string(),
        partsCount: z.number(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),

  listServiceOrderBusinessErrors: z.union([
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

  serviceOrderUpdated: z.object({
    message: z.string().default("Ordem de serviço atualizada com sucesso!"),
  }),

  serviceOrderDeleted: z.object({
    message: z.string().default("Ordem de serviço deletada com sucesso!"),
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

  serviceOrderNotFound: z.object({
    message: z.string().default("Ordem de serviço não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado."),
  }),

  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),

  supplierNotFound: z.object({
    message: z.string().default("Fornecedor não encontrado."),
  }),

  serviceOrderInUse: z.object({
    message: z
      .string()
      .default(
        "Não é possível excluir esta ordem de serviço pois ela está sendo usada em contas a pagar.",
      ),
  }),

  // Grouping errors by route
  createServiceOrderErrors: z.union([
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
      message: z.string().default("Veículo não encontrado."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada."),
    }),
    z.object({
      message: z.string().default("Fornecedor não encontrado."),
    }),
    z.object({
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este fornecedor não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Usuário responsável não encontrado!"),
    }),
    z.object({
      message: z.string().default("Este usuário não pertence a esta empresa!"),
    }),
  ]),

  listServiceOrderErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Usuário não possui empresa associada!"),
    }),
  ]),

  updateServiceOrderErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada."),
    }),
    z.object({
      message: z.string().default("Fornecedor não encontrado."),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este fornecedor não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Usuário responsável não encontrado!"),
    }),
    z.object({
      message: z.string().default("Este usuário não pertence a esta empresa!"),
    }),
  ]),

  deleteServiceOrderErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir esta ordem de serviço pois ela está sendo usada em contas a pagar.",
        ),
    }),
  ]),
};

export { serviceOrderSchemas, serviceOrderResponses };
