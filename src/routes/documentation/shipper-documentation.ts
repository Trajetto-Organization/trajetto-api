import { z } from "zod";

import { createShipperSchema } from "@/schemas/create-shipper-schema";
import { updateShipperSchema } from "@/schemas/update-shipper-schema";

import { listShipperSchema } from "@/schemas/list-shipper-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteShipperSchema } from "@/schemas/update-delete-shipper-schema";

const shipperEntity = z.object({
  id: z.string(),
  name: z.string(),
  corporate_reason: z
    .string()
    .nullable()
    .describe(
      "Razão social, impressa no comprovante (decisão 14.8); nula = o nome.",
    ),
  cnpj: z.string().nullable(),
  email: z.string().nullable(),
  telephone: z.string().nullable(),
  is_active: z.boolean(),
  businessId: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const shipperSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  shipperBusinessParams: updateDeleteBusinessSchema.merge(
    updateDeleteShipperSchema,
  ),
  createShipper: createShipperSchema,
  updateShipper: updateShipperSchema,
  listShippers: listShipperSchema,
  searchShipperCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de embarcadores a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID do último embarcador da página anterior para paginação"),
    search: z
      .string()
      .max(100)
      .optional()
      .describe("Nome, CNPJ ou e-mail; até 100 caracteres."),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const shipperResponses = {
  shipperCreated: z.object({
    message: z.string().default("Embarcador criado com sucesso!"),
  }),
  shipperUpdated: z.object({
    message: z.string().default("Embarcador atualizado com sucesso!"),
  }),
  shipperDeleted: z.object({
    message: z.string().default("Embarcador excluído com sucesso!"),
  }),
  shipperList: z.object({
    data: z.array(shipperEntity),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  lookupNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  shipperNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "SHIPPER_NOT_FOUND (o embarcador não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "SHIPPER_NOT_FOUND (o embarcador não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  codedError: z.object({ code: z.string(), message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { shipperSchemas, shipperResponses };
