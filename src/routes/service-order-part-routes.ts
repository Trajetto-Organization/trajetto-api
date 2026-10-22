import { FastifyInstance } from "fastify";

import { CreateServiceOrderPartController } from "@/modules/service-order-part/usecases/create-service-order-part/create-service-order-part-controller";
import { ListServiceOrderPartController } from "@/modules/service-order-part/usecases/list-service-order-part/list-service-order-part-controller";

import { UpdateServiceOrderPartController } from "@/modules/service-order-part/usecases/update-service-order-part/update-service-order-part-controller";
import { DeleteServiceOrderPartController } from "@/modules/service-order-part/usecases/delete-service-order-part/delete-service-order-part-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  serviceOrderPartSchemas,
  serviceOrderPartResponses,
} from "./documentation/service-order-part-documentation";
import { itemOf, ndjsonList, offsetMetaWith } from "./documentation/ndjson";

const createServiceOrderPartController = new CreateServiceOrderPartController();
const listServiceOrderPartController = new ListServiceOrderPartController();

const updateServiceOrderPartController = new UpdateServiceOrderPartController();
const deleteServiceOrderPartController = new DeleteServiceOrderPartController();

async function serviceOrderPartRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest). MASTER is checked on
  // every company the request names (decision 4.3).
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-service-order-part/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("service_order_part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Adiciona uma peça à ordem de serviço",
        description:
          "Lança uma peça do catálogo da empresa na ordem, com quantidade, preço unitário (sem ele, o da peça) e desconto. Ordem inexistente ou de outra empresa, 404 SERVICE_ORDER_NOT_FOUND; peça inexistente ou de outra empresa, 404 PART_NOT_FOUND (a mesma resposta nos dois casos, que não confirma que o ID existe). A mesma peça duas vezes na ordem, 409 SERVICE_ORDER_PART_ALREADY_EXISTS. A resposta traz o valor total digitado da ordem e a soma das peças (totals), e partsExceedTotal quando as peças passam do total: um aviso, nunca recusa.",
        params: serviceOrderPartSchemas.createServiceOrderPartParams,
        body: serviceOrderPartSchemas.createServiceOrderPart,
        response: {
          201: serviceOrderPartResponses.serviceOrderPartCreated,
          400: serviceOrderPartResponses.createServiceOrderPartErrors,
          404: serviceOrderPartResponses.serviceOrderPartNotFound,
          409: serviceOrderPartResponses.serviceOrderPartConflict,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    createServiceOrderPartController.handle,
  );

  app.get(
    "/list-service-order-part",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Lista as peças lançadas nas ordens de serviço",
        description:
          "Uma empresa por vez: o MASTER informa businessId (sem ele, 400 BUSINESS_NOT_IDENTIFIED). Ordena no servidor (sort/order), filtra por peça (partId) e por ordem de serviço (serviceOrderId), e busca por ID do lançamento, ID da ordem, descrição da peça ou placa do veículo. A primeira linha (meta) traz o total do filtro e, em searchMeta, os cartões (valor com desconto, lançamentos com desconto, valor médio) e as opções do filtro de peça, calculados sobre a empresa inteira.",
        querystring: serviceOrderPartSchemas.listServiceOrderPart,
        response: {
          200: ndjsonList(
            itemOf(serviceOrderPartResponses.serviceOrderPartList),
            offsetMetaWith(
              serviceOrderPartResponses.serviceOrderPartSearchMeta,
            ),
          ),
          400: serviceOrderPartResponses.genericError,
          404: serviceOrderPartResponses.sessionUserNotFound,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    listServiceOrderPartController.handle,
  );

  app.patch(
    "/update-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("service_order_part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Atualiza uma peça da ordem de serviço",
        description:
          "Edita quantidade, preço, desconto ou a peça do lançamento. Ordem inexistente ou de outra empresa, 404 SERVICE_ORDER_NOT_FOUND; peça nova inexistente ou de outra empresa, 404 PART_NOT_FOUND; lançamento de outra ordem (ou de outra empresa), 404 SERVICE_ORDER_PART_NOT_FOUND. A resposta traz totals e partsExceedTotal, como na criação.",
        params: serviceOrderPartSchemas.serviceOrderPartParams,
        body: serviceOrderPartSchemas.updateServiceOrderPart,
        response: {
          200: serviceOrderPartResponses.serviceOrderPartUpdated,
          400: serviceOrderPartResponses.updateServiceOrderPartErrors,
          404: serviceOrderPartResponses.serviceOrderPartNotFound,
          409: serviceOrderPartResponses.serviceOrderPartConflict,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    updateServiceOrderPartController.handle,
  );

  app.delete(
    "/delete-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // A deactivated company is read-only (TENANT_INACTIVE), as on the
      // create and update beside it: a MASTER token names no company, so
      // nothing else stops this delete.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("service_order_part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Remove uma peça da ordem de serviço",
        description:
          "Apaga o lançamento da peça na ordem (o catálogo não muda). Ordem inexistente ou de outra empresa, 404 SERVICE_ORDER_NOT_FOUND; lançamento de outra ordem (ou de outra empresa), 404 SERVICE_ORDER_PART_NOT_FOUND.",
        params: serviceOrderPartSchemas.serviceOrderPartParams,
        response: {
          200: serviceOrderPartResponses.serviceOrderPartDeleted,
          400: serviceOrderPartResponses.deleteServiceOrderPartErrors,
          404: serviceOrderPartResponses.serviceOrderPartNotFound,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    deleteServiceOrderPartController.handle,
  );
}

export { serviceOrderPartRoutes };
