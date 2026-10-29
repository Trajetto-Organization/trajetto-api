import { z } from "zod";

import { createServiceOrderPartSchema } from "@/schemas/create-service-order-part-schema";
import { updateServiceOrderPartSchema } from "@/schemas/update-service-order-part-schema";

import { listServiceOrderPartSchema } from "@/schemas/list-service-order-part-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { errorResponse } from "./common-responses";

/**
 * Every error body these routes send: `code` is what a client branches on,
 * and a schema listing only `message` stripped it on the way out (the zod
 * serializer drops unknown keys).
 */
const codedError = (description: string) => errorResponse.describe(description);

/** The listing's `meta.searchMeta`: cards and the part filter's options. */
const serviceOrderPartSearchMetaDoc = searchMetaDoc(
  {
    total: z.number().int().describe("Lançamentos com todos os filtros."),
    withDiscount: z.number().int().describe("Dos quais com desconto."),
    totalValue: z
      .number()
      .describe("Soma de preço × quantidade − desconto, em reais."),
    averageValue: z.number().describe("Valor médio por lançamento, em reais."),
  },
  ["partId"],
);

/** The order's money after a part change (FLEET-SO-2): a warning, never a refusal. */
const totalsFields = {
  totals: z
    .object({
      totalAmount: z.number().describe("Valor total digitado da ordem."),
      partsTotal: z
        .number()
        .describe("Soma das peças da ordem (preço × quantidade − desconto)."),
    })
    .optional(),
  partsExceedTotal: z
    .boolean()
    .optional()
    .describe(
      "true quando as peças sozinhas passam do valor total da ordem: a tela avisa para revisar o valor.",
    ),
};

const serviceOrderPartParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
  serviceOrderPartId: z
    .string()
    .uuid("O ID da peça de ordem de serviço é obrigatório!"),
});

const createServiceOrderPartParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
});

const serviceOrderPartSchemas = {
  createServiceOrderPart: createServiceOrderPartSchema,
  listServiceOrderPart: listServiceOrderPartSchema,
  updateServiceOrderPart: updateServiceOrderPartSchema,
  serviceOrderPartParams: serviceOrderPartParams,
  createServiceOrderPartParams: createServiceOrderPartParams,
};

const serviceOrderPartResponses = {
  serviceOrderPartCreated: z.object({
    message: z
      .string()
      .default("Peça adicionada à ordem de serviço com sucesso!"),
    ...totalsFields,
  }),
  serviceOrderPartList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        unit_price: z.union([z.string(), z.number()]),
        quantity: z.number(),
        discount_percentage: z
          .union([z.string(), z.number()])
          .nullable()
          .optional(),
        businessId: z.string(),
        serviceOrderId: z.string(),
        partId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        part: z.object({
          id: z.string(),
          description: z.string(),
          unit_price: z.union([z.string(), z.number()]),
          businessId: z.string(),
          supplierId: z.string().nullable(),
          created_at: z.union([z.string(), z.date()]),
          updated_at: z.union([z.string(), z.date()]),
        }),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(),
        serviceOrder: z.object({
          id: z.string(),
          date: z.union([z.string(), z.date()]),
          total_amount: z.number(),
          completion_date: z.union([z.string(), z.date()]).nullable(),
          vehicle: z.object({
            license_plate: z.string(),
            description: z.string(),
          }),
        }),
      }),
    ),
    total: z.number(),
  }),

  serviceOrderPartUpdated: z.object({
    message: z
      .string()
      .default("Peça da ordem de serviço atualizada com sucesso!"),
    ...totalsFields,
  }),

  serviceOrderPartSearchMeta: serviceOrderPartSearchMetaDoc,

  genericError: errorResponse,

  serviceOrderPartDeleted: z.object({
    message: z
      .string()
      .default("Peça removida da ordem de serviço com sucesso!"),
  }),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  createServiceOrderPartErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado (issues diz qual).",
  ),

  updateServiceOrderPartErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado (issues diz qual).",
  ),

  // A gone session user is 404 (in serviceOrderPartNotFound); delete's only
  // 400 is a malformed path.
  deleteServiceOrderPartErrors: codedError(
    "VALIDATION_ERROR: um parâmetro do caminho foi recusado (issues diz qual).",
  ),

  sessionUserNotFound: codedError(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  serviceOrderPartNotFound: codedError(
    "SERVICE_ORDER_NOT_FOUND: a ordem do caminho não existe ou é de outra empresa. PART_NOT_FOUND: a peça informada não existe ou é de outra empresa. SERVICE_ORDER_PART_NOT_FOUND: o lançamento não é desta ordem. Uma ID de outra empresa recebe a mesma resposta de uma inexistente, que não confirma que ela existe. TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND: a empresa do caminho não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  serviceOrderPartConflict: codedError(
    "SERVICE_ORDER_PART_ALREADY_EXISTS: a peça já está nesta ordem; altere a quantidade do lançamento existente.",
  ),
};

export { serviceOrderPartSchemas, serviceOrderPartResponses };
