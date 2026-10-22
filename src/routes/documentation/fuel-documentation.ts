import { z } from "zod";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { updateFuelSchema } from "@/schemas/update-fuel-schema";

import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";
import { idempotencyHeaders } from "./idempotency-documentation";
import { errorResponse, internalErrorResponse } from "./common-responses";

const fuelSchemas = {
  // What the app really POSTs: the form fields the controller validates with
  // createFuelSchema, plus the key of the odometer photo it already uploaded.
  // Documentation only (see routes/documentation/openapi-transform).
  createFuelBody: z
    .object({
      photo: presignedPhotoSchema.describe(
        "A foto do odômetro, já enviada ao storage: a `key` devolvida por POST /uploads/presign/:businessId. Obrigatória.",
      ),
    })
    .and(createFuelSchema),
  updateFuelBody: z
    .object({
      photo: presignedPhotoSchema
        .optional()
        .describe("Nova foto do odômetro, se trocou; mesma regra do cadastro."),
    })
    .and(updateFuelSchema),
  idempotencyHeaders,
  updateDeleteFuel: updateDeleteFuelSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  searchFuelByVehicleParams: updateDeleteVehicleSchema,
  getPreviousFuelParams: z.object({
    vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
  }),
  getPreviousFuelQuery: z.object({
    date: z
      .string({
        required_error: "A data do abastecimento atual é obrigatória!",
      })
      // An unparseable date reached Prisma as Invalid Date: a 500.
      .refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "A data do abastecimento atual é inválida.",
      })
      .describe("Data do abastecimento atual; volta o último anterior a ela."),
    businessId: z
      .string({ required_error: "O ID da empresa é obrigatório!" })
      .uuid("O ID da empresa deve ser um UUID válido!")
      .describe("A empresa do veículo."),
  }),
  searchFuelByVehicleCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de abastecimentos a retornar (padrão: 10)."),
    cursor: z
      .string()
      .optional()
      .describe("ID do último abastecimento da página anterior (paginação)."),
    search: z
      .string()
      .optional()
      .describe("Texto livre (até 100 caracteres), como a busca da listagem."),
  }),
};

/** One refueling as the list and a vehicle's history stream it. */
const fuelRow = z.object({
  id: z.string().describe("ID do abastecimento."),
  current_mileage: z
    .number()
    .describe("Quilometragem do veículo no abastecimento."),
  liters_amount: z.number().describe("Litros abastecidos (até 3 casas)."),
  price_per_liter: z
    .number()
    .describe("Preço por litro, em reais (até 3 casas)."),
  total_amount: z
    .number()
    .describe(
      "Valor total, em reais: litros × preço, calculado pelo servidor.",
    ),
  odometer_photo: z
    .string()
    .nullable()
    .describe("URL assinada e temporária da foto do odômetro."),
  odometer_verified: z
    .boolean()
    .describe("Se a leitura do odômetro foi confirmada pela análise da foto."),
  odometer_ai_status: z
    .string()
    .describe(
      "Situação da análise da foto: pending, analyzing, verified, mismatch, fraud, unreadable, error ou skipped.",
    ),
  notes: z.string().nullable().describe("Observações."),
  refueling_date: z
    .union([z.string(), z.date()])
    .describe("Data e hora do abastecimento (ISO 8601)."),
  created_from: z
    .string()
    .describe("Origem do registro: MOBILE_APP ou WEB_DASHBOARD."),
  businessId: z.string().describe("Empresa."),
  branchId: z.string().describe("Filial."),
  vehicleId: z.string().describe("Veículo."),
  driverId: z.string().describe("Motorista."),
  fuelTypeId: z.string().describe("Tipo de combustível."),
  branch: z
    .object({
      corporate_reason: z.string().describe("Razão social da filial."),
    })
    .optional(),
  vehicle: z
    .object({
      description: z.string().describe("Descrição do veículo."),
      license_plate: z.string().describe("Placa."),
      brand: z.string().describe("Marca."),
      model: z.string().describe("Modelo."),
    })
    .optional(),
  driver: z
    .object({
      name: z.string().describe("Nome do motorista."),
      cnh: z.string().describe("CNH do motorista."),
    })
    .optional(),
  fuelType: z
    .object({ description: z.string().describe("Nome do combustível.") })
    .optional(),
  latitude: z.number().nullable().optional().describe("Latitude do posto."),
  longitude: z.number().nullable().optional().describe("Longitude do posto."),
  created_at: z.union([z.string(), z.date()]).describe("Criação do registro."),
  updated_at: z
    .union([z.string(), z.date()])
    .describe("Última alteração do registro."),
});

const fuelResponses = {
  fuelCreated: z.object({
    message: z.string().default("Abastecimento criado com sucesso!"),
    // The controller sends it; a schema without it stripped it on the way out.
    id: z.string().describe("Id do abastecimento criado."),
  }),
  fuelUpdated: z.object({
    message: z.string().default("Abastecimento atualizado com sucesso!"),
  }),
  fuelDeleted: z.object({
    message: z.string().default("Abastecimento excluído com sucesso!"),
  }),
  fuelList: z.object({ data: z.array(fuelRow) }),
  previousFuelReading: z
    .object({
      vehicleId: z.string().describe("Veículo."),
      refueling_date: z
        .union([z.string(), z.date()])
        .describe("Data e hora do abastecimento anterior."),
      current_mileage: z
        .number()
        .describe("Quilometragem no abastecimento anterior."),
      liters_amount: z.number().describe("Litros abastecidos nele."),
    })
    .nullable()
    .describe(
      "O abastecimento anterior só com o que o consumo usa (data, quilometragem e litros): sem quem abasteceu, preço, local, observações ou foto. `null` quando não há.",
    ),
  internalServerError: internalErrorResponse,

  // Refusals with their codes. `errorResponse` keeps `code` in the body: a
  // schema that listed only `message` stripped it on the way out.
  createFuelErrors: errorResponse.describe(
    "Recusa com `code` (também no header x-error-code): VALIDATION_ERROR, PHOTO_REQUIRED, USER_NOT_FOUND, VEHICLE_NOT_FOUND, DRIVER_NOT_FOUND ou FUEL_TYPE_NOT_FOUND (inexistente ou de outra empresa, a mesma resposta), VEHICLE_MILEAGE_INVALID (a quilometragem não se encaixa no histórico do veículo), VEHICLE_NOT_FUELABLE (veículo que não está ativo nem em rota), REFUELING_DATE_IN_FUTURE, LOCATION_REQUIRED, LOCATION_ORIGINAL_REQUIRED ou LOCATION_ADJUSTMENT_TOO_FAR (o ponto ajustado à mão está a mais de 500 m do capturado pelo GPS).",
  ),
  updateFuelErrors: errorResponse.describe(
    "Recusa com `code`: VALIDATION_ERROR, USER_NOT_FOUND, VEHICLE_NOT_FOUND, DRIVER_NOT_FOUND ou FUEL_TYPE_NOT_FOUND (vínculo inexistente ou de outra empresa, a mesma resposta), VEHICLE_MILEAGE_INVALID (a quilometragem não se encaixa no histórico do veículo), VEHICLE_NOT_FUELABLE (mover para um veículo que não está ativo nem em rota) ou REFUELING_DATE_IN_FUTURE.",
  ),
  // The use case's 404s; the route guards add theirs (TENANT_NOT_FOUND,
  // BRANCH_NOT_FOUND) to the same status in the published document.
  createNotFound: errorResponse.describe(
    "BRANCH_NOT_FOUND: a filial não existe ou é de outra empresa (a mesma resposta, também para o MASTER). BUSINESS_NOT_FOUND: a empresa informada não existe.",
  ),
  writeForbidden: errorResponse.describe(
    "PERMISSION_DENIED, MODULE_NOT_ENABLED, TENANT_INACTIVE, TENANT_ACCESS_DENIED, VEHICLE_NOT_ASSIGNED_TO_DRIVER (o motorista só abastece o veículo em que é responsável ou o da sua rota liberada ou em andamento), DRIVER_CANNOT_UPDATE_FUEL ou DRIVER_CANNOT_DELETE_FUEL (motoristas só criam).",
  ),
  fuelNotFound: errorResponse.describe(
    "FUEL_NOT_FOUND: o abastecimento não existe ou é de outra empresa (a mesma resposta). BUSINESS_NOT_FOUND: a empresa informada não existe.",
  ),
  updateNotFound: errorResponse.describe(
    "FUEL_NOT_FOUND: o abastecimento não existe ou é de outra empresa (a mesma resposta). BRANCH_NOT_FOUND: a filial para onde o registro vai não existe ou é de outra empresa. BUSINESS_NOT_FOUND: a empresa informada não existe.",
  ),
  vehicleReadErrors: errorResponse.describe(
    "USER_NOT_FOUND ou VALIDATION_ERROR (data ou parâmetros inválidos).",
  ),
  vehicleReadForbidden: errorResponse.describe(
    "PERMISSION_DENIED, MODULE_NOT_ENABLED, TENANT_INACTIVE, TENANT_ACCESS_DENIED ou VEHICLE_NOT_ASSIGNED_TO_DRIVER (o motorista pediu um veículo da empresa que não é o dele nem o da sua rota liberada ou em andamento).",
  ),
  vehicleNotFound: errorResponse.describe(
    "VEHICLE_NOT_FOUND: o veículo não existe ou é de outra empresa (a mesma resposta). BUSINESS_NOT_FOUND: a empresa não existe.",
  ),
  exportFuelErrors: errorResponse.describe(
    "VALIDATION_ERROR, BUSINESS_NOT_IDENTIFIED (o MASTER não informou a empresa), USER_NOT_FOUND ou NOTHING_TO_EXPORT (o filtro não trouxe nenhum abastecimento).",
  ),

  // The two refusals the app's outbox has to tell apart from a plain 400.
  // `code` is listed so the serializer keeps it: the outbox branches on it.
  writeConflict: z
    .object({
      code: z.string().describe("SUBMISSION_OWNER_MISMATCH ou BRANCH_INACTIVE"),
      message: z.string(),
    })
    .describe(
      "SUBMISSION_OWNER_MISMATCH: a chave de idempotência já foi usada por outro motorista desta empresa — gere uma chave nova e reenvie; repetir a mesma nunca passa. BRANCH_INACTIVE: a filial do abastecimento está desativada.",
    ),
  driverInactive: z
    .object({
      code: z.string().describe("DRIVER_INACTIVE"),
      message: z.string(),
    })
    .describe(
      "O motorista informado está inativo. Definitivo: repetir não muda a resposta.",
    ),
  // The edit's only conflict: it carries no idempotency key to collide with.
  branchInactive: z
    .object({
      code: z.string().describe("BRANCH_INACTIVE"),
      message: z.string(),
    })
    .describe(
      "BRANCH_INACTIVE: a filial informada está desativada. Nada foi gravado; repetir não muda a resposta.",
    ),
};

export { fuelSchemas, fuelResponses };
