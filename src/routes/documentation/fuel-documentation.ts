import { z } from "zod";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { updateFuelSchema } from "@/schemas/update-fuel-schema";

import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import {
  listFuelByVehicleParamsSchema,
  listFuelByVehicleQuerySchema,
} from "@/schemas/list-fuel-by-vehicle-schema";

const fuelSchemas = {
  createFuel: createFuelSchema,
  updateFuel: updateFuelSchema,
  updateDeleteFuel: updateDeleteFuelSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  listFuel: listPagesSchema,
  listFuelBusiness: listPagesByBusinessSchema,
  listFuelByVehicleParams: listFuelByVehicleParamsSchema,
  listFuelByVehicleQuery: listFuelByVehicleQuerySchema,
  exportFuelsQuery: z.object({
    search: z.string().optional().describe("Search term to filter fuels"),
  }),
  getPreviousFuelParams: z.object({
    vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
  }),
  getPreviousFuelQuery: z.object({
    date: z.string({
      required_error: "A data do abastecimento atual é obrigatória!",
    }),
    businessId: z
      .string({ required_error: "O ID da empresa é obrigatório!" })
      .uuid("O ID da empresa deve ser um UUID válido!"),
  }),
};

const fuelResponses = {
  fuelCreated: z.object({
    message: z.string().default("Abastecimento criado com sucesso!"),
  }),
  fuelUpdated: z.object({
    message: z.string().default("Abastecimento atualizado com sucesso!"),
  }),
  fuelDeleted: z.object({
    message: z.string().default("Abastecimento excluído com sucesso!"),
  }),
  fuelList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Fuel record ID"),
        current_mileage: z.number().describe("Current vehicle mileage"),
        liters_amount: z
          .number()
          .describe("Amount of fuel in liters (RAW number)"),
        price_per_liter: z.number().describe("Price per liter (RAW number)"),
        total_amount: z.number().describe("Total amount paid (RAW number)"),
        odometer_photo: z.string().nullable().describe("Odometer photo URL"),
        odometer_verified: z.boolean().describe("Whether odometer is verified"),
        notes: z.string().nullable().describe("Additional notes"),
        refueling_date: z
          .union([z.string(), z.date()])
          .describe("Date of refueling"),
        businessId: z.string().describe("Business ID"),
        branchId: z.string().describe("Branch ID"),
        vehicleId: z.string().describe("Vehicle ID"),
        driverId: z.string().describe("Driver ID"),
        fuelTypeId: z.string().describe("Fuel type ID"),
        business: z
          .object({
            corporate_reason: z.string().describe("Business corporate reason"),
          })
          .optional()
          .describe("Business relation (nested object)"), // Only for MASTER role
        branch: z
          .object({
            corporate_reason: z.string().describe("Branch corporate reason"),
          })
          .optional()
          .describe("Branch relation (nested object)"),
        vehicle: z
          .object({
            description: z.string().describe("Vehicle description"),
            license_plate: z.string().describe("Vehicle license plate"),
            brand: z.string().describe("Vehicle brand"),
            model: z.string().describe("Vehicle model"),
          })
          .optional()
          .describe("Vehicle relation (nested object)"),
        driver: z
          .object({
            name: z.string().describe("Driver name"),
            cnh: z.string().describe("Driver license number"),
          })
          .optional()
          .describe("Driver relation (nested object)"),
        fuelType: z
          .object({
            description: z.string().describe("Fuel type description"),
          })
          .optional()
          .describe("Fuel type relation (nested object)"),
        latitude: z
          .number()
          .nullable()
          .optional()
          .describe("Geolocation latitude"),
        longitude: z
          .number()
          .nullable()
          .optional()
          .describe("Geolocation longitude"),
        created_at: z
          .union([z.string(), z.date()])
          .describe("Creation timestamp"),
        updated_at: z
          .union([z.string(), z.date()])
          .describe("Last update timestamp"),
      }),
    ),
    total: z.number().describe("Total number of fuel records"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado!"),
  }),
  driverNotFound: z.object({
    message: z.string().default("Motorista não encontrado!"),
  }),
  fuelTypeNotFound: z.object({
    message: z.string().default("Tipo de combustível não encontrado!"),
  }),
  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada!"),
  }),
  fuelNotFound: z.object({
    message: z
      .string()
      .default(
        "Registro de abastecimento não encontrado ou não pertence a esta empresa.",
      ),
  }),
  vehicleNotBelongBusiness: z.object({
    message: z.string().default("Este veículo não pertence a esta empresa!"),
  }),
  listFuelByVehicleErrors: z.union([
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
  ]),
  driverNotBelongBusiness: z.object({
    message: z.string().default("Este motorista não pertence a esta empresa!"),
  }),
  fuelTypeNotBelongBusiness: z.object({
    message: z
      .string()
      .default(
        "O tipo de combustível informado não pertence à mesma empresa do usuário.",
      ),
  }),
  branchNotBelongBusiness: z.object({
    message: z
      .string()
      .default("A filial informada não pertence à mesma empresa do usuário."),
  }),
  fuelNotBelongBusiness: z.object({
    message: z
      .string()
      .default("Este registro de abastecimento não pertence a esta empresa!"),
  }),
  vehicleMileageInvalid: z.object({
    message: z
      .string()
      .default(
        "A quilometragem informada deve ser maior que a quilometragem atual do veículo!",
      ),
  }),
  vehicleInvalidStatusForFuel: z.object({
    message: z
      .string()
      .default(
        "Não é possível abastecer um veículo que não esteja ativo ou em rota.",
      ),
  }),
  vehicleNotAssignedToDriver: z.object({
    message: z
      .string()
      .default(
        "Você não tem permissão para acessar este veículo. Este veículo não está atribuído a você.",
      ),
  }),
  fuelLocationNotProvidedAdjustmentValidation: z.object({
    message: z
      .string()
      .default("Localização original não fornecida para validação de ajuste."),
  }),
  fuelRegistrationsMobileLocationRequired: z.object({
    message: z
      .string()
      .default(
        "Para registros via aplicativo mobile, a localização é obrigatória.",
      ),
  }),
  driverCannotUpdateFuel: z.object({
    message: z
      .string()
      .default(
        "Motoristas não possuem permissão para editar registros de abastecimento. Apenas criar novos.",
      ),
  }),
  driverCannotDeleteFuel: z.object({
    message: z
      .string()
      .default(
        "Motoristas não possuem permissão para deletar registros de abastecimento.",
      ),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z.array(z.string()).describe("List of validation errors"),
  }),
  listFuelErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),
  listFuelBusinessErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação"),
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
  fuelReturned: z
    .object({
      id: z.string().describe("Fuel record ID"),
      current_mileage: z.number().describe("Current vehicle mileage"),
      liters_amount: z
        .union([z.number(), z.instanceof(Object)])
        .describe("Amount of fuel in liters"),
      price_per_liter: z
        .union([z.number(), z.instanceof(Object)])
        .describe("Price per liter"),
      total_amount: z
        .union([z.number(), z.instanceof(Object)])
        .describe("Total amount paid"),
      odometer_photo: z
        .string()
        .nullable()
        .optional()
        .describe("Odometer photo path"),
      odometer_verified: z.boolean().describe("Whether odometer is verified"),
      notes: z.string().nullable().optional().describe("Additional notes"),
      refueling_date: z
        .union([z.string(), z.date()])
        .describe("Date of refueling"),
      businessId: z.string().describe("Business ID"),
      branchId: z.string().describe("Branch ID"),
      vehicleId: z.string().describe("Vehicle ID"),
      driverId: z.string().describe("Driver ID"),
      fuelTypeId: z.string().describe("Fuel type ID"),
      created_at: z
        .union([z.string(), z.date()])
        .describe("Creation timestamp"),
      updated_at: z
        .union([z.string(), z.date()])
        .describe("Last update timestamp"),
    })
    .nullable(),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  getPreviousFuelNotFound: z.object({
    message: z.string().default("Nenhum abastecimento anterior encontrado."),
  }),

  // Composite responses for 404 Not Found
  deleteFuelNotFoundErrors: z.union([
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
          "Registro de abastecimento não encontrado ou não pertence a esta empresa.",
        ),
    }),
  ]),

  // Composite responses for create fuel
  createFuelErrors: z.union([
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
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado!"),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O tipo de combustível informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("A filial informada não pertence à mesma empresa do usuário."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A quilometragem informada deve ser maior que a quilometragem atual do veículo!",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível abastecer um veículo que não esteja ativo ou em rota.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Você não tem permissão para acessar este veículo. Este veículo não está atribuído a você.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Localização original não fornecida para validação de ajuste.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Para registros via aplicativo mobile, a localização é obrigatória.",
        ),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  // Composite responses for update fuel
  updateFuelErrors: z.union([
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
          "Registro de abastecimento não encontrado ou não pertence a esta empresa.",
        ),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Tipo de combustível não encontrado!"),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este registro de abastecimento não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Este veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O tipo de combustível informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("A filial informada não pertence à mesma empresa do usuário."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A quilometragem informada deve ser maior que a quilometragem atual do veículo!",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível abastecer um veículo que não esteja ativo ou em rota.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Motoristas não possuem permissão para editar registros de abastecimento. Apenas criar novos.",
        ),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  // Composite responses for get previous fuel
  getPreviousFuelErrors: z.union([
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

export { fuelSchemas, fuelResponses };
