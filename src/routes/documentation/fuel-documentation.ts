import { z } from "zod";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { updateFuelSchema } from "@/schemas/update-fuel-schema";

import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const fuelSchemas = {
  createFuel: createFuelSchema,
  updateFuel: updateFuelSchema,
  updateDeleteFuel: updateDeleteFuelSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  listFuel: listPagesSchema,
  listFuelBusiness: listPagesByBusinessSchema,
  exportFuelsQuery: z.object({
    search: z.string().optional().describe("Search term to filter fuels"),
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
        liters_amount: z.number().describe("Amount of fuel in liters"),
        price_per_liter: z.number().describe("Price per liter"),
        total_amount: z.number().describe("Total amount paid"),
        odometer_photo: z.string().nullable().describe("Odometer photo path"),
        odometer_verified: z.boolean().describe("Whether odometer is verified"),
        notes: z.string().nullable().describe("Additional notes"),
        refueling_date: z.string().describe("Date of refueling"),
        businessId: z.string().describe("Business ID"),
        branchId: z.string().describe("Branch ID"),
        vehicleId: z.string().describe("Vehicle ID"),
        driverId: z.string().describe("Driver ID"),
        fuelTypeId: z.string().describe("Fuel type ID"),
        business_name: z.string().optional().describe("Business name"),
        branch_name: z.string().describe("Branch name"),
        vehicle_description: z.string().describe("Vehicle description"),
        vehicle_license_plate: z.string().describe("Vehicle license plate"),
        vehicle_brand: z.string().describe("Vehicle brand"),
        vehicle_model: z.string().describe("Vehicle model"),
        driver_name: z.string().describe("Driver name"),
        driver_cnh: z.string().describe("Driver license number"),
        fuel_type_description: z.string().describe("Fuel type description"),
        created_at: z.string().describe("Creation timestamp"),
        updated_at: z.string().describe("Last update timestamp"),
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
    message: z.string().default("Abastecimento não encontrado!"),
  }),
  vehicleNotBelongBusiness: z.object({
    message: z
      .string()
      .default("O veículo informado não pertence à mesma empresa do usuário."),
  }),
  driverNotBelongBusiness: z.object({
    message: z
      .string()
      .default(
        "O motorista informado não pertence à mesma empresa do usuário.",
      ),
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
      .default(
        "O abastecimento informado não pertence à mesma empresa do usuário.",
      ),
  }),
  vehicleMileageInvalid: z.object({
    message: z.string().default("A quilometragem atual do veículo é inválida."),
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
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),
};

export { fuelSchemas, fuelResponses };
