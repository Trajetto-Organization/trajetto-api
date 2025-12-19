import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";
import { updateVehicleChecklistSchema } from "@/schemas/update-vehicle-checklist-schema";

const vehicleChecklistSchemas = {
  createVehicleChecklist: createVehicleChecklistSchema,
  updateVehicleChecklist: updateVehicleChecklistSchema,
  listVehicleChecklist: listPagesSchema,
  listVehicleChecklistBusiness: listPagesByBusinessSchema,
  updateDeleteVehicleChecklist: z.object({
    checklistId: z.string().uuid(),
    businessId: z.string().uuid(),
  }),
  updateDeleteBusiness: updateDeleteBusinessSchema,
  businessIdParam: updateDeleteBusinessSchema,
};

const vehicleChecklistResponses = {
  vehicleChecklistCreated: z.object({
    message: z.string().default("Checklist veicular criado com sucesso!"),
  }),
  vehicleChecklistUpdated: z.object({
    message: z.string().default("Checklist veicular atualizado com sucesso!"),
  }),
  vehicleChecklistDeleted: z.object({
    message: z.string().default("Checklist veicular excluído com sucesso!"),
  }),
  vehicleChecklistList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Vehicle checklist record ID"),
        current_mileage: z.number().describe("Current vehicle mileage"),
        checklist_date: z.string().describe("Date of checklist inspection"),
        tires_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of tires"),
        headlights_working: z
          .boolean()
          .describe("Whether headlights are working"),
        taillights_working: z
          .boolean()
          .describe("Whether taillights are working"),
        turn_signals_working: z
          .boolean()
          .describe("Whether turn signals are working"),
        bumpers_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of bumpers"),
        windshield_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of windshield"),
        mirrors_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of mirrors"),
        seatbelts_working: z
          .boolean()
          .describe("Whether seatbelts are working"),
        dashboard_working: z.boolean().describe("Whether dashboard is working"),
        steering_wheel_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of steering wheel"),
        brakes_working: z.boolean().describe("Whether brakes are working"),
        clutch_working: z.boolean().describe("Whether clutch is working"),
        fuel_level_adequate: z
          .boolean()
          .describe("Whether fuel level is adequate"),
        oil_level_adequate: z
          .boolean()
          .describe("Whether oil level is adequate"),
        radiator_water_adequate: z
          .boolean()
          .describe("Whether radiator water is adequate"),
        brake_fluid_adequate: z
          .boolean()
          .describe("Whether brake fluid is adequate"),
        battery_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of battery"),
        driver_license_valid: z
          .boolean()
          .describe("Whether driver license is valid"),
        vehicle_documents_valid: z
          .boolean()
          .describe("Whether vehicle documents are valid"),
        insurance_valid: z.boolean().describe("Whether insurance is valid"),
        fire_extinguisher_valid: z
          .boolean()
          .describe("Whether fire extinguisher is valid"),
        warning_triangle_present: z
          .boolean()
          .describe("Whether warning triangle is present"),
        jack_present: z.boolean().describe("Whether jack is present"),
        spare_tire_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of spare tire"),
        notes: z.string().nullable().describe("Additional notes"),
        photos: z.array(z.string()).describe("Array of photo URLs"),
        overall_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Overall vehicle condition"),
        businessId: z.string().describe("Business ID"),
        branchId: z.string().describe("Branch ID"),
        vehicleId: z.string().describe("Vehicle ID"),
        driverId: z.string().describe("Driver ID"),
        business_name: z.string().optional().describe("Business name"),
        branch_name: z.string().describe("Branch name"),
        vehicle_description: z
          .string()
          .nullable()
          .describe("Vehicle description"),
        vehicle_license_plate: z
          .string()
          .nullable()
          .describe("Vehicle license plate"),
        vehicle_brand: z.string().nullable().describe("Vehicle brand"),
        vehicle_model: z.string().nullable().describe("Vehicle model"),
        driver_name: z.string().nullable().describe("Driver name"),
        driver_cnh: z.string().nullable().describe("Driver CNH"),
        created_at: z.string().describe("Creation date"),
        updated_at: z.string().describe("Last update date"),
      }),
    ),
    total: z.number().describe("Total number of records"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado."),
  }),
  businessNotFound: z.object({
    message: z.string().default("Empresa não encontrada."),
  }),
  vehicleChecklistNotFound: z.object({
    message: z.string().default("Checklist veicular não encontrado."),
  }),
  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado."),
  }),
  driverNotFound: z.object({
    message: z.string().default("Motorista não encontrado."),
  }),
  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),
  vehicleChecklistNotBelongBusiness: z.object({
    message: z
      .string()
      .default("Este checklist veicular não pertence a esta empresa."),
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
  branchNotBelongBusiness: z.object({
    message: z
      .string()
      .default("A filial informada não pertence à mesma empresa do usuário."),
  }),
  vehicleMileageInvalid: z.object({
    message: z
      .string()
      .default(
        "A quilometragem informada não pode ser menor que a quilometragem atual do veículo.",
      ),
  }),
  requiredPhotosMissing: z.object({
    message: z.string().default("Fotos obrigatórias não fornecidas."),
    errors: z.array(z.string()).optional(),
    missingPhotos: z.array(z.string()).optional(),
  }),
  fileSizeTooLarge: z.object({
    message: z
      .string()
      .default(
        "O tamanho total dos arquivos excede o limite permitido de 5MB.",
      ),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação nos dados fornecidos."),
    details: z.string().optional(),
  }),
  listVehicleChecklistErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação nos dados fornecidos."),
    }),
    z.object({ message: z.string().default("Recurso não encontrado.") }),
  ]),
  listVehicleChecklistBusinessErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação nos dados fornecidos."),
    }),
    z.object({ message: z.string().default("Recurso não encontrado.") }),
    z.object({ message: z.string().default("Empresa não encontrada.") }),
  ]),
  createVehicleChecklistErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação nos dados fornecidos."),
      details: z.string().optional(),
    }),
    z.object({ message: z.string().default("Recurso não encontrado.") }),
    z.object({ message: z.string().default("Empresa não encontrada.") }),
    z.object({ message: z.string().default("Veículo não encontrado.") }),
    z.object({ message: z.string().default("Motorista não encontrado.") }),
    z.object({ message: z.string().default("Filial não encontrada.") }),
    z.object({
      message: z
        .string()
        .default(
          "O veículo informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O motorista informado não pertence à mesma empresa do usuário.",
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
          "A quilometragem informada não pode ser menor que a quilometragem atual do veículo.",
        ),
    }),
    z.object({
      message: z.string().default("Fotos obrigatórias não fornecidas."),
      errors: z.array(z.string()).optional(),
      missingPhotos: z.array(z.string()).optional(),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O tamanho total dos arquivos excede o limite permitido de 5MB.",
        ),
    }),
  ]),
  updateVehicleChecklistErrors: z.union([
    z.object({
      message: z.string().default("Erro de validação nos dados fornecidos."),
      details: z.string().optional(),
    }),
    z.object({ message: z.string().default("Recurso não encontrado.") }),
    z.object({ message: z.string().default("Empresa não encontrada.") }),
    z.object({
      message: z.string().default("Checklist veicular não encontrado."),
    }),
    z.object({
      message: z
        .string()
        .default("Checklist não encontrado ou não pertence a esta empresa."),
    }),
    z.object({ message: z.string().default("Veículo não encontrado.") }),
    z.object({ message: z.string().default("Motorista não encontrado.") }),
    z.object({ message: z.string().default("Filial não encontrada.") }),
    z.object({
      message: z
        .string()
        .default(
          "O veículo informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O motorista informado não pertence à mesma empresa do usuário.",
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
          "A quilometragem informada não pode ser menor que a quilometragem atual do veículo.",
        ),
    }),
    z.object({
      message: z.string().default("Fotos obrigatórias não fornecidas."),
      errors: z.array(z.string()).optional(),
      missingPhotos: z.array(z.string()).optional(),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O tamanho total dos arquivos excede o limite permitido de 5MB.",
        ),
    }),
  ]),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { vehicleChecklistSchemas, vehicleChecklistResponses };
