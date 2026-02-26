import { z } from "zod";

import { createServiceOrderSchema } from "@/schemas/create-service-order-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateServiceOrderSchema } from "@/schemas/update-service-order-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import {
  listServiceOrderByVehicleParamsSchema,
  listServiceOrderByVehicleQuerySchema,
} from "@/schemas/list-service-order-by-vehicle-schema";

const serviceOrderBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
});

const serviceOrderSchemas = {
  createServiceOrder: createServiceOrderSchema,
  listServiceOrder: listPagesSchema,
  listServiceOrderBusinessSchema: listPagesByBusinessSchema,
  listServiceOrderByVehicleParams: listServiceOrderByVehicleParamsSchema,
  listServiceOrderByVehicleQuery: listServiceOrderByVehicleQuerySchema,
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
        date: z.union([z.string(), z.date()]),
        completion_date: z.union([z.string(), z.date()]).nullable(),
        maintenance_type: z.enum(["INTERNAL", "EXTERNAL"]),
        total_amount: z.number(),
        current_mileage_at_service: z.number().nullable(),
        maintenance_interval_km_at_service: z.number().nullable(),
        last_maintenance_mileage_at_service: z.number().nullable(),
        new_mileage_after_service: z.number().nullable(),
        businessId: z.string(),
        vehicleId: z.string(),
        responsibleUserId: z.string(),
        branchId: z.string(),
        supplierId: z.string().nullable(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        latitude_original: z.number().nullable(),
        longitude_original: z.number().nullable(),
        location_source: z.string().nullable(),
        location_edited_by: z.string().nullable(),
        location_edited_at: z.union([z.string(), z.date()]).nullable(),
        created_from: z.enum(["WEB", "MOBILE", "WEB_DASHBOARD"]),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
        vehicle: z
          .object({
            license_plate: z.string(),
            description: z.string(),
          })
          .optional(),
        responsibleUser: z
          .object({
            name: z.string(),
            email: z.string(),
          })
          .optional(),
        branch: z
          .object({
            corporate_reason: z.string(),
            fantasy_name: z.string(),
          })
          .optional(),
        supplier: z
          .object({
            name: z.string(),
          })
          .nullable()
          .optional(),
        parts: z
          .array(
            z.object({
              id: z.string(),
              quantity: z.number(),
              unit_price: z.number(),
              serviceOrderId: z.string(),
              partId: z.string(),
              part: z.object({
                id: z.string(),
                description: z.string(),
              }),
            }),
          )
          .optional(),
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
      message: z.string().default("Usuário responsável não encontrado!"),
    }),
  ]),

  createServiceOrderForbiddenErrors: z.union([
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

  listServiceOrderByVehicleErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado."),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  listServiceOrderByVehicleForbiddenErrors: z.object({
    message: z.string().default("Este veículo não pertence a esta empresa!"),
  }),

  vehicleNotBelongBusiness: z.object({
    message: z.string().default("Este veículo não pertence a esta empresa!"),
  }),

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
      message: z.string().default("Usuário responsável não encontrado!"),
    }),
  ]),

  updateServiceOrderForbiddenErrors: z.union([
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
        .default(
          "Não é possível excluir esta ordem de serviço pois ela está sendo usada em contas a pagar.",
        ),
    }),
  ]),

  deleteServiceOrderForbiddenErrors: z.object({
    message: z
      .string()
      .default("Esta ordem de serviço não pertence a esta empresa!"),
  }),
};

export { serviceOrderSchemas, serviceOrderResponses };
