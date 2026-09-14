import { z } from "zod";

import { createShipperSchema } from "@/schemas/create-shipper-schema";
import { updateShipperSchema } from "@/schemas/update-shipper-schema";

import { listShipperSchema } from "@/schemas/list-shipper-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteShipperSchema } from "@/schemas/update-delete-shipper-schema";

const shipperEntity = z.object({
  id: z.string(),
  name: z.string(),
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
  searchShipperStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {searchMeta: {nextCursor, hasMore}}. Subsequent lines are shipper objects.",
      ),
  }),
  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { shipperSchemas, shipperResponses };
