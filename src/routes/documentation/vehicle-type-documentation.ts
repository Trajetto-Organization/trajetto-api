import { z } from "zod";

import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";
import { listVehicleTypeSchema } from "@/schemas/list-vehicle-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { errorResponse } from "./common-responses";

const vehicleTypeBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  vehicleTypeId: z.string().uuid("O ID do tipo de veículo é obrigatório!"),
});

const vehicleTypeSchemas = {
  createVehicleType: createVehicleTypeSchema,
  listVehicleType: listVehicleTypeSchema,
  updateVehicleType: updateVehicleTypeSchema,
  businessIdParam: updateDeleteBusinessSchema,
  vehicleTypeBusinessParams: vehicleTypeBusinessParams,
  searchVehicleTypeCursor: cursorPaginationByBusinessSchema,
};

const dateLike = z.union([z.string(), z.date()]);

const cnhCategory = z
  .enum(["A", "B", "C", "D", "E", "AB", "AC", "AD", "AE"])
  .nullable()
  .describe(
    "Categoria de CNH exigida para dirigir este tipo; null = não configurada (a atribuição não confere).",
  );

const vehicleTypeItem = z.object({
  id: z.string(),
  description: z.string(),
  number_of_axles: z
    .number()
    .int()
    .describe("Eixos padrão; o veículo pode sobrescrever."),
  required_cnh_category: cnhCategory,
  businessId: z.string(),
  created_at: dateLike,
  updated_at: dateLike,
});

const message = (text: string) =>
  z.object({ message: z.string().default(text) });

const vehicleTypeResponses = {
  vehicleTypeCreated: message("Tipo de veículo criado com sucesso!"),
  vehicleTypeUpdated: message("Tipo de veículo atualizado com sucesso!"),
  vehicleTypeDeleted: message("Tipo de veículo deletado com sucesso!"),

  vehicleTypeItem,
  vehicleTypeListItem: vehicleTypeItem.extend({
    _count: z
      .object({ vehicles: z.number().int() })
      .describe(
        "Veículos cadastrados com este tipo (a exclusão é recusada enquanto houver).",
      ),
  }),

  validationError: errorResponse.describe(
    "VALIDATION_ERROR (campo inválido, ordenação fora da lista) ou BUSINESS_NOT_IDENTIFIED (MASTER sem empresa).",
  ),
  notFound: errorResponse.describe(
    "VEHICLE_TYPE_NOT_FOUND, BUSINESS_NOT_FOUND ou USER_NOT_FOUND (o usuário da sessão não existe mais). Um tipo de outra empresa responde exatamente como um inexistente.",
  ),
  // The list only looks the session user up; no type id to miss.
  sessionUserNotFound: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  nameConflict: errorResponse.describe(
    "VEHICLE_TYPE_NAME_TAKEN: já existe um tipo com este nome nesta empresa.",
  ),
  deleteConflict: errorResponse.describe(
    "VEHICLE_TYPE_IN_USE: veículos ainda usam o tipo; a mensagem traz a contagem.",
  ),
  internalServerError: errorResponse,
};

export { vehicleTypeSchemas, vehicleTypeResponses };
