import { z } from "zod";

import { createPartSchema } from "@/schemas/create-part-schema";
import { listPartSchema } from "@/schemas/list-part-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { errorResponse } from "./common-responses";

/**
 * Every error body these routes send: `code` is what a client branches on,
 * and a schema listing only `message` stripped it on the way out (the zod
 * serializer drops unknown keys).
 */
const codedError = (description: string) => errorResponse.describe(description);

/** The catalog's `meta.searchMeta`: cards and the supplier filter's options. */
const partSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Peças da busca, sem o filtro de fornecedor (o total dos cartões).",
      ),
    withSupplier: z.number().int().describe("Das quais com fornecedor."),
    withoutSupplier: z.number().int().describe("Das quais sem fornecedor."),
    averagePrice: z
      .number()
      .describe("Preço unitário médio das mesmas peças, em reais."),
  },
  ["supplierId"],
);

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updatePartSchema } from "@/schemas/update-part-schema";

const partBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  partId: z.string().uuid("O ID da peça é obrigatório!"),
});

const partSchemas = {
  createPart: createPartSchema,
  listPart: listPartSchema,
  updatePart: updatePartSchema,
  businessIdParam: updateDeleteBusinessSchema,
  partBusinessParams: partBusinessParams,
  searchPartCursor: cursorPaginationByBusinessSchema,
};

const partResponses = {
  partCreated: z.object({
    message: z.string().default("Peça criada com sucesso!"),
  }),

  partList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        unit_price: z.union([z.string(), z.number()]),
        businessId: z.string().optional(),
        supplierId: z.string().nullable().optional(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        supplier: z
          .object({
            name: z.string(),
          })
          .nullable()
          .optional(),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .nullable()
          .optional(),
        service_order_parts_count: z
          .number()
          .int()
          .optional()
          .describe(
            "Na listagem: lançamentos em ordens de serviço. Com algum, a peça não pode ser excluída.",
          ),
      }),
    ),
    total: z.number(),
  }),

  partSearchMeta: partSearchMetaDoc,

  partBusinessErrors: codedError(
    "VALIDATION_ERROR: limite, cursor ou busca inválidos. BUSINESS_NOT_IDENTIFIED: o MASTER não informou a empresa.",
  ),

  partUpdated: z.object({
    message: z.string().default("Peça atualizada com sucesso!"),
  }),

  partDeleted: z.object({
    message: z.string().default("Peça deletada com sucesso!"),
  }),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  createPartErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado (issues diz qual). SUPPLIER_NOT_FOUND: o fornecedor não existe ou é de outra empresa — a mesma resposta, que não confirma que o ID existe.",
  ),

  updatePartErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado. SUPPLIER_NOT_FOUND: o fornecedor não existe ou é de outra empresa (a mesma resposta). A empresa de uma peça não muda (decisão 16.100): um `businessId` no corpo é VALIDATION_ERROR.",
  ),

  partNotFound: codedError(
    "PART_NOT_FOUND: a peça não existe ou é de outra empresa — a mesma resposta, que não confirma que o ID existe. TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND: a empresa do caminho não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  partConflict: codedError(
    "PART_ALREADY_EXISTS: outra peça da empresa já tem esta descrição (sem diferenciar maiúsculas nem espaços nas pontas). PART_IN_USE: a peça está em lançamentos de ordem de serviço.",
  ),

  // A gone session user is a 404 (USER_NOT_FOUND, in partNotFound); the
  // only 400 left on delete is a malformed path.
  deletePartErrors: codedError(
    "VALIDATION_ERROR: um parâmetro do caminho foi recusado (issues diz qual).",
  ),

  // Create and search name the company; the list resolves it from the token.
  partLookupNotFound: codedError(
    "USER_NOT_FOUND (o usuário da sessão não existe mais), TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND (a empresa informada não existe).",
  ),

  sessionUserNotFound: codedError(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  listPartErrors: codedError(
    "VALIDATION_ERROR: ordenação, filtro ou paginação inválidos. BUSINESS_NOT_IDENTIFIED: o MASTER não informou a empresa.",
  ),
};

export { partSchemas, partResponses };
