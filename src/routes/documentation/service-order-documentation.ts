import { z } from "zod";

import { createServiceOrderSchema } from "@/schemas/create-service-order-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateServiceOrderSchema } from "@/schemas/update-service-order-schema";

import {
  exportServiceOrderSchema,
  listServiceOrderSchema,
} from "@/schemas/list-service-order-schema";

import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { errorResponse } from "./common-responses";

/**
 * Every error body these routes send: `code` is what a client branches on,
 * and a schema listing only `message` stripped it on the way out (the zod
 * serializer drops unknown keys).
 */
const codedError = (description: string) => errorResponse.describe(description);

/**
 * The list's `meta.searchMeta`, as summarizeServiceOrderList builds it: the
 * cards and the options of the three server-side filters.
 */
const serviceOrderSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Ordens da busca e dos demais filtros, sem o de situação (abertas + concluídas).",
      ),
    open: z.number().int().describe("Das quais sem data de conclusão."),
    completed: z.number().int().describe("Das quais concluídas."),
    totalAmount: z
      .number()
      .describe(
        "Soma do valor total (total_amount) das ordens que a tabela mostra, com todos os filtros.",
      ),
  },
  ["status", "maintenanceType", "branchId"],
);

const serviceOrderBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  serviceOrderId: z.string().uuid("O ID da ordem de serviço é obrigatório!"),
});

const serviceOrderSchemas = {
  createServiceOrder: createServiceOrderSchema,
  listServiceOrder: listServiceOrderSchema,
  updateServiceOrder: updateServiceOrderSchema,
  searchServiceOrderByVehicleParams: updateDeleteVehicleSchema,
  businessIdParam: updateDeleteBusinessSchema,
  serviceOrderBusinessParams: serviceOrderBusinessParams,
  exportServiceOrderQuery: exportServiceOrderSchema,
  searchServiceOrderBusinessCursor: cursorPaginationByBusinessSchema,
  searchServiceOrderByVehicleCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de ordens de serviço a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe(
        "ID da última ordem de serviço da página anterior para paginação",
      ),
  }),
};

const serviceOrderResponses = {
  serviceOrderCreated: z.object({
    message: z.string().default("Ordem de serviço criada com sucesso!"),
  }),
  serviceOrderList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        date: z.union([z.string(), z.date()]),
        completion_date: z.union([z.string(), z.date()]).nullable(),
        maintenance_type: z.enum(["INTERNAL", "EXTERNAL"]),
        total_amount: z.number(),
        description: z
          .string()
          .nullable()
          .describe("Descrição livre do que se trata a ordem de serviço."),
        current_mileage_at_service: z.number().nullable(),
        maintenance_interval_km_at_service: z.number().nullable(),
        last_maintenance_mileage_at_service: z.number().nullable(),
        new_mileage_after_service: z.number().nullable(),
        businessId: z.string(),
        vehicleId: z.string(),
        responsibleUserId: z.string(),
        branchId: z.string(),
        supplierId: z.string().nullable(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        latitude_original: z.number().nullable(),
        longitude_original: z.number().nullable(),
        location_source: z.string().nullable(),
        location_edited_by: z.string().nullable(),
        location_edited_at: z.union([z.string(), z.date()]).nullable(),
        created_from: z.enum(["MOBILE_APP", "WEB_DASHBOARD"]),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(),
        vehicle: z
          .object({
            license_plate: z.string(),
            description: z.string(),
          })
          .optional(),
        responsibleUser: z
          .object({
            name: z.string(),
            email: z.string(),
          })
          .optional(),
        branch: z
          .object({
            corporate_reason: z.string(),
            fantasy_name: z.string(),
          })
          .optional(),
        supplier: z
          .object({
            name: z.string(),
          })
          .nullable()
          .optional(),
        parts: z
          .array(
            z.object({
              id: z.string(),
              quantity: z.number(),
              unit_price: z.number(),
              discount_percentage: z.number().nullable(),
              serviceOrderId: z.string(),
              partId: z.string(),
              part: z.object({
                id: z.string(),
                description: z.string(),
              }),
            }),
          )
          .optional(),
        parts_total: z
          .number()
          .optional()
          .describe(
            "Na listagem: soma das peças (preço × quantidade − desconto). O valor total é digitado (mão de obra + peças); a tela avisa quando as peças sozinhas passam dele.",
          ),
        parts_count: z
          .number()
          .int()
          .optional()
          .describe("Na listagem: quantas peças a ordem tem."),
        accounts_payable_count: z
          .number()
          .int()
          .optional()
          .describe(
            "Na listagem: contas a pagar vinculadas. Com alguma, a ordem não pode ser excluída.",
          ),
      }),
    ),
    total: z.number(),
  }),

  listServiceOrderBusinessErrors: codedError(
    "VALIDATION_ERROR: limite, cursor ou busca inválidos. BUSINESS_NOT_IDENTIFIED: o MASTER não informou a empresa.",
  ),

  serviceOrderUpdated: z.object({
    message: z.string().default("Ordem de serviço atualizada com sucesso!"),
  }),

  serviceOrderDeleted: z.object({
    message: z.string().default("Ordem de serviço deletada com sucesso!"),
    partsRemoved: z
      .number()
      .int()
      .describe("Peças da ordem removidas junto com ela."),
  }),

  /** The list's meta line: pager total, cards and filter options. */
  serviceOrderSearchMeta: serviceOrderSearchMetaDoc,

  genericError: errorResponse,

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  createServiceOrderErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado (issues diz qual). VEHICLE_NOT_FOUND, SUPPLIER_NOT_FOUND ou RESPONSIBLE_USER_NOT_FOUND: o veículo, o fornecedor ou o responsável não existe ou é de outra empresa — a mesma resposta, que não confirma que o ID existe. SERVICE_ORDER_COMPLETION_BEFORE_DATE: conclusão antes da data da ordem. SERVICE_ORDER_MILEAGE_REQUIRED: concluída sem a nova quilometragem. SERVICE_ORDER_MILEAGE_BEHIND: nova quilometragem menor que a do veículo. LOCATION_REQUIRED ou LOCATION_ORIGINAL_REQUIRED: registro do app sem a localização exigida. LOCATION_ADJUSTMENT_TOO_FAR: o ponto ajustado à mão está a mais de 500 m do capturado pelo GPS.",
  ),

  updateServiceOrderErrors: codedError(
    "VALIDATION_ERROR: um campo foi recusado (issues diz qual). VEHICLE_NOT_FOUND, SUPPLIER_NOT_FOUND ou RESPONSIBLE_USER_NOT_FOUND: o vínculo não existe ou é de outra empresa (a mesma resposta). SERVICE_ORDER_COMPLETION_BEFORE_DATE, SERVICE_ORDER_MILEAGE_REQUIRED ou SERVICE_ORDER_MILEAGE_BEHIND: como na criação; numa ordem já concluída, SERVICE_ORDER_MILEAGE_BEHIND compara a correção com a quilometragem da abertura da ordem. SERVICE_ORDER_MILEAGE_AHEAD: a correção passa o hodômetro, e há manutenção registrada depois desta ordem.",
  ),

  serviceOrderNotFound: codedError(
    "SERVICE_ORDER_NOT_FOUND: a ordem não existe ou é de outra empresa — a mesma resposta, que não confirma que o ID existe. BRANCH_NOT_FOUND: a filial informada não existe ou é de outra empresa. TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND: a empresa do caminho não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  createServiceOrderNotFound: codedError(
    "BRANCH_NOT_FOUND: a filial informada não existe ou é de outra empresa (a mesma resposta). TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND: a empresa do caminho não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  exportServiceOrderNotFound: codedError(
    "BUSINESS_NOT_FOUND: a empresa informada não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  sessionUserNotFound: codedError("USER_NOT_FOUND: o usuário da sessão não existe mais."),

  serviceOrderConflict: codedError(
    "SERVICE_ORDER_HAS_ACCOUNTS_PAYABLE: uma conta a pagar aponta para a ordem. SERVICE_ORDER_COMPLETED: a ordem está concluída.",
  ),

  // A gone session user is 404 (in serviceOrderNotFound); delete's only 400
  // is a malformed path.
  deleteServiceOrderErrors: codedError(
    "VALIDATION_ERROR: um parâmetro do caminho foi recusado (issues diz qual).",
  ),
};

export { serviceOrderSchemas, serviceOrderResponses };
