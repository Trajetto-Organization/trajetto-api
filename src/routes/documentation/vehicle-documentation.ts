import { z } from "zod";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { getVehicleSchema } from "@/schemas/get-vehicle-schema";

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
};

const vehicleResponses = {
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
        acquisition_date: z.string(),
        fleet_type: z.enum(["OWNED", "THIRD_PARTY"]),
        fleet_id: z.string().nullable(),
        last_maintenance_date: z.string().nullable(),
        current_mileage: z.number().or(z.string()),
        last_maintenance_mileage: z
          .number()
          .nullable()
          .or(z.string().nullable()),
        maintenance_interval_km: z.number().or(z.string()),
        maintenance_interval_months: z.number().or(z.string()),
        renavam: z.string(),
        manufacturing_year: z.number().or(z.string()),
        model_year: z.number().or(z.string()),
        km_per_liter: z.number().or(z.string()),
        number_of_axles: z.number().or(z.string()),
        status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"]),
        vehicleTypeId: z.string().nullable(),
        vehicleTypeDescription: z.string().optional(),
        fuelTypeId: z.string(),
        fuelTypeDescription: z.string().optional(),
        driverId: z.string().nullable(),
        driverName: z.string().optional(),
        branchId: z.string().nullable(),
        branchName: z.string().optional(),
        businessId: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
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
    z.object({
      message: z
        .string()
        .default("Um veículo com este RENAVAM já foi cadastrado!"),
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
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este veículo pois ele está sendo usado em ordens de serviço.",
        ),
    }),
  ]),

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
};

export { vehicleSchemas, vehicleResponses };
