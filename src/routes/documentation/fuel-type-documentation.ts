import { z } from "zod";

import { createFuelTypeSchema } from "@/schemas/create-fuel-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateFuelTypeSchema } from "@/schemas/update-fuel-type-schema";

import { errorResponse, internalErrorResponse } from "./common-responses";

const fuelTypeBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  fuelTypeId: z.string().uuid("O ID do tipo de combustível é obrigatório!"),
});

const fuelTypeSchemas = {
  createFuelType: createFuelTypeSchema,
  updateFuelType: updateFuelTypeSchema,
  businessIdParam: updateDeleteBusinessSchema,
  fuelTypeBusinessParams: fuelTypeBusinessParams,
  searchFuelTypeCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe(
        "Número máximo de tipos de combustível a retornar (padrão: 10)",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "ID do último tipo de combustível da página anterior (paginação)",
      ),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe("Texto livre, até 100 caracteres."),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const fuelTypeResponses = {
  fuelTypeCreated: z.object({
    message: z.string().default("Tipo de combustível criado com sucesso!"),
  }),

  fuelTypeList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
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

  fuelTypeUpdated: z.object({
    message: z.string().default("Tipo de combustível atualizado com sucesso!"),
  }),

  fuelTypeDeleted: z.object({
    message: z.string().default("Tipo de combustível deletado com sucesso!"),
  }),

  internalServerError: internalErrorResponse,

  // Refusals with their codes (fuel-type-http-errors.ts). `errorResponse`
  // keeps `code` in the body: the old per-message unions listed only
  // `message` and none of these codes.
  writeErrors: errorResponse.describe(
    "VALIDATION_ERROR (corpo ou parâmetros inválidos) ou USER_NOT_FOUND.",
  ),
  listErrors: errorResponse.describe(
    "VALIDATION_ERROR (parâmetros inválidos, ordenação que o servidor não oferece), BUSINESS_NOT_IDENTIFIED (o MASTER não informou a empresa) ou USER_NOT_FOUND.",
  ),
  searchErrors: errorResponse.describe(
    "VALIDATION_ERROR (parâmetros inválidos) ou USER_NOT_FOUND.",
  ),
  businessNotFound: errorResponse.describe(
    "BUSINESS_NOT_FOUND: a empresa informada não existe.",
  ),
  fuelTypeNotFound: errorResponse.describe(
    "FUEL_TYPE_NOT_FOUND: o tipo de combustível não existe ou é de outra empresa (a mesma resposta). BUSINESS_NOT_FOUND: a empresa informada não existe.",
  ),
  alreadyExists: errorResponse.describe(
    "FUEL_TYPE_ALREADY_EXISTS: a empresa já tem este combustível.",
  ),
  updateConflict: errorResponse.describe(
    "FUEL_TYPE_ALREADY_EXISTS: a empresa já tem um tipo com este combustível.",
  ),
  deleteConflict: errorResponse.describe(
    "FUEL_TYPE_IN_USE: há veículos ou abastecimentos com este tipo; a mensagem traz a contagem. Nada foi excluído.",
  ),
};

export { fuelTypeSchemas, fuelTypeResponses };
