import { z } from "zod";

import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";

const vehicleTypeBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  vehicleTypeId: z.string().uuid("O ID do tipo de veículo é obrigatório!"),
});

const vehicleTypeSchemas = {
  createVehicleType: createVehicleTypeSchema,
  listVehicleType: listPagesSchema,
  listVehicleTypeBusiness: listPagesByBusinessSchema,
  updateVehicleType: updateVehicleTypeSchema,
  businessIdParam: updateDeleteBusinessSchema,
  vehicleTypeBusinessParams: vehicleTypeBusinessParams,
};

const vehicleTypeResponses = {
  vehicleTypeCreated: z.object({
    message: z.string().default("Tipo de veículo criado com sucesso!"),
  }),

  vehicleTypeList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        number_of_axles: z.number(),
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

  vehicleTypeUpdated: z.object({
    message: z.string().default("Tipo de veículo atualizado com sucesso!"),
  }),

  vehicleTypeDeleted: z.object({
    message: z.string().default("Tipo de veículo deletado com sucesso!"),
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

  vehicleTypeNotFound: z.object({
    message: z.string().default("Tipo de veículo não encontrado!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  vehicleTypeAlreadyExists: z.object({
    message: z
      .string()
      .default("Este tipo de veículo já foi cadastrado para esta empresa!"),
  }),

  // Grouping errors by route
  createVehicleTypeErrors: z.union([
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
        .default("Este tipo de veículo já foi cadastrado para esta empresa!"),
    }),
  ]),

  listVehicleTypeErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  listVehicleTypeBusinessErrors: z.union([
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

  updateVehicleTypeErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de veículo não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Este tipo de veículo já foi cadastrado para esta empresa!"),
    }),
  ]),

  deleteVehicleTypeErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de veículo não encontrado!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
  ]),

  vehicleTypeNotBelongBusinessError: z.object({
    message: z
      .string()
      .default("Este tipo de veículo não pertence a esta empresa!"),
  }),
};

export { vehicleTypeSchemas, vehicleTypeResponses };
