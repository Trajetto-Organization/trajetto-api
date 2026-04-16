import { z } from "zod";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { getVehicleSchema } from "@/schemas/get-vehicle-schema";
import { exportReports } from "@/schemas/export-reports-schema";

const vehicleBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
});

const vehicleSchemas = {
  createVehicle: createVehicleSchema,
  updateVehicle: updateVehicleSchema,
  listVehicle: listPagesSchema,
  listVehicleBusinessSchema: listPagesByBusinessSchema,
  businessIdParam: updateDeleteBusinessSchema,
  vehicleIdParam: updateDeleteVehicleSchema,
  vehicleBusinessParams: vehicleBusinessParams,
  getVehicle: getVehicleSchema,
  exportVehicleQuery: exportReports,
  searchVehicleCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de empresas a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última empresa da página anterior para paginação"),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const vehicleResponses = {
  searchVehicleStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are vehicle objects.",
      ),
  }),
  vehicleCreated: z.object({
    message: z.string().default("Veículo criado com sucesso!"),
  }),

  vehicleList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        license_plate: z.string(),
        brand: z.string(),
        model: z.string(),
        acquisition_date: z.union([z.string(), z.date()]),
        fleet_type: z.enum(["OWNED", "THIRD_PARTY"]),
        fleet_id: z.string().nullable(),
        last_maintenance_date: z.union([z.string(), z.date()]).nullable(),
        current_mileage: z.number(),
        last_maintenance_mileage: z.number().nullable(),
        maintenance_interval_km: z.number(),
        maintenance_interval_months: z.number(),
        renavam: z.string(),
        manufacturing_year: z.number(),
        model_year: z.number(),
        km_per_liter: z.number(),
        number_of_axles: z.number(),
        status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"]),
        vehicleTypeId: z.string().nullable(),
        fuelTypeId: z.string(),
        driverId: z.string().nullable(),
        branchId: z.string().nullable(),
        businessId: z.string(),
        last_fuel_mileage: z.number().nullable().optional(),
        last_fuel_date: z.union([z.string(), z.date()]).nullable().optional(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        vehicleType: z
          .object({
            description: z.string(),
          })
          .nullable()
          .optional(),
        fuelType: z
          .object({
            description: z.string(),
          })
          .optional(),
        driver: z
          .object({
            name: z.string(),
            cnh: z.string(),
          })
          .nullable()
          .optional(),
        branch: z
          .object({
            corporate_reason: z.string(),
          })
          .nullable()
          .optional(),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
      }),
    ),
    total: z.number(),
  }),

  listVehicleBusinessErrors: z.union([
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

  vehicleUpdated: z.object({
    message: z.string().default("Veículo atualizado com sucesso!"),
  }),

  vehicleDeleted: z.object({
    message: z.string().default("Veículo deletado com sucesso!"),
  }),

  vehicleReturned: z.object({
    id: z.string().describe("Vehicle ID"),
    description: z.string().describe("Vehicle description"),
    license_plate: z.string().describe("Vehicle license plate"),
    brand: z.string().describe("Vehicle brand"),
    model: z.string().describe("Vehicle model"),
    acquisition_date: z
      .union([z.string(), z.date()])
      .describe("Vehicle acquisition date"),
    fleet_type: z.enum(["OWNED", "THIRD_PARTY"]).describe("Fleet type"),
    fleet_id: z
      .string()
      .nullable()
      .optional()
      .describe("Fleet ID if third party"),
    last_maintenance_date: z
      .union([z.string(), z.date()])
      .nullable()
      .optional()
      .describe("Last maintenance date"),
    current_mileage: z.number().describe("Current vehicle mileage"),
    last_maintenance_mileage: z
      .number()
      .nullable()
      .optional()
      .describe("Mileage at last maintenance"),
    maintenance_interval_km: z
      .number()
      .describe("Maintenance interval in kilometers"),
    maintenance_interval_months: z
      .number()
      .describe("Maintenance interval in months"),
    renavam: z.string().describe("Vehicle RENAVAM number"),
    manufacturing_year: z
      .union([z.string(), z.date()])
      .describe("Vehicle manufacturing year"),
    model_year: z.union([z.string(), z.date()]).describe("Vehicle model year"),
    km_per_liter: z.number().describe("Fuel efficiency in km per liter"),
    number_of_axles: z.number().describe("Number of vehicle axles"),
    status: z
      .enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"])
      .describe("Vehicle status"),
    businessId: z.string().describe("Business ID"),
    vehicleTypeId: z.string().nullable().optional().describe("Vehicle type ID"),
    fuelTypeId: z.string().describe("Fuel type ID"),
    driverId: z.string().nullable().optional().describe("Assigned driver ID"),
    branchId: z.string().nullable().optional().describe("Assigned branch ID"),
    last_fuel_mileage: z
      .number()
      .nullable()
      .optional()
      .describe("Mileage at last fuel refill"),
    last_fuel_date: z
      .union([z.string(), z.date()])
      .nullable()
      .optional()
      .describe("Date of last fuel refill"),
    created_at: z
      .union([z.string(), z.date()])
      .describe("Vehicle creation timestamp"),
    updated_at: z
      .union([z.string(), z.date()])
      .describe("Vehicle last update timestamp"),
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

  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  vehicleTypeNotFound: z.object({
    message: z.string().default("Tipo de veículo não encontrado."),
  }),

  fuelTypeNotFound: z.object({
    message: z.string().default("Tipo de combustível não encontrado."),
  }),

  driverNotFound: z.object({
    message: z.string().default("Motorista não encontrado."),
  }),

  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),

  vehicleAlreadyExists: z.object({
    message: z
      .string()
      .default("Este veículo já foi cadastrado para esta empresa!"),
  }),

  vehicleInUse: z.object({
    message: z
      .string()
      .default(
        "Não é possível excluir este veículo pois ele está sendo usado em ordens de serviço.",
      ),
  }),

  vehicleRenavamExists: z.object({
    message: z
      .string()
      .default("Um veículo com este RENAVAM já foi cadastrado!"),
  }),

  // Grouping errors by route
  createVehicleErrors: z.union([
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
      message: z.string().default("Tipo de veículo não encontrado."),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado."),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada."),
    }),
    z.object({
      message: z
        .string()
        .default("Este veículo já foi cadastrado para esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Um veículo com este RENAVAM já foi cadastrado!"),
    }),
  ]),

  createVehicleForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Este tipo de veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este tipo de combustível não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
  ]),

  listVehicleErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  updateVehicleErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Tipo de veículo não encontrado."),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado."),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada."),
    }),
  ]),

  updateVehicleForbiddenErrors: z.union([
    z.object({
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este tipo de veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este tipo de combustível não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
  ]),

  deleteVehicleErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este veículo pois ele está sendo usado em ordens de serviço.",
        ),
    }),
  ]),

  deleteVehicleForbiddenErrors: z.object({
    message: z.string().default("Este veículo não pertence a esta empresa!"),
  }),

  getVehicleErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
  ]),

  // Export errors (GET /export-vehicle)
  exportVehicleErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Não existem veículos para exportar!"),
    }),
  ]),
};

export { vehicleSchemas, vehicleResponses };
