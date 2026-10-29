import { FastifyInstance } from "fastify";

import { CreateServiceOrderController } from "@/modules/service-order/usecases/create-service-order/create-service-order-controller";
import { ListServiceOrderController } from "@/modules/service-order/usecases/list-service-order/list-service-order-controller";

import { UpdateServiceOrderController } from "@/modules/service-order/usecases/update-service-order/update-service-order-controller";
import { DeleteServiceOrderController } from "@/modules/service-order/usecases/delete-service-order/delete-service-order-controller";

import { SearchServiceOrderCursorController } from "@/modules/service-order/usecases/search-service-order-cursor/search-service-order-cursor-controller";
import { SearchServiceOrderByVehicleCursorController } from "@/modules/service-order/usecases/search-service-order-by-vehicle-cursor/search-service-order-by-vehicle-cursor-controller";

import { ExportServiceOrderController } from "@/modules/service-order/usecases/export-service-order/export-service-order-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import {
  serviceOrderSchemas,
  serviceOrderResponses,
} from "./documentation/service-order-documentation";
import {
  itemOf,
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";
import { panelIdempotencyHeaders } from "./documentation/idempotency-documentation";

const createServiceOrderController = new CreateServiceOrderController();
const listServiceOrderController = new ListServiceOrderController();

const searchServiceOrderCursorController =
  new SearchServiceOrderCursorController();
const searchServiceOrderByVehicleCursorController =
  new SearchServiceOrderByVehicleCursorController();

const exportServiceOrderController = new ExportServiceOrderController();

const updateServiceOrderController = new UpdateServiceOrderController();
const deleteServiceOrderController = new DeleteServiceOrderController();

/**
 * Company-wide reads are not the driver's (decision 4.4): the driver sees the
 * orders of the vehicle they drive through search-service-order-by-vehicle,
 * which checks that link. The key alone (`service_order_manage:read`) would
 * let a driver token list every order of the company.
 */
const managerRead = verifyPermission("service_order_manage", "read", {
  allowDriver: false,
});

async function serviceOrderRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest).
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-service-order/:businessId",
    {
      // Documentation only; see idempotency-documentation (IDEMP-14).
      config: { openapi: { headers: panelIdempotencyHeaders } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("service_order_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Cria uma ordem de serviço",
        description:
          "Registra uma manutenção do veículo. Criada já concluída, a nova quilometragem é obrigatória e pode ser igual à atual (veículo parado na oficina): igual, só a última manutenção do veículo é gravada; maior, o hodômetro avança junto, na mesma transação. Menor é recusada (400 SERVICE_ORDER_MILEAGE_BEHIND). Veículo, fornecedor ou responsável inexistente ou de outra empresa recebe a mesma resposta (400 com o código *_NOT_FOUND), que não confirma que o ID existe; a filial, 404 BRANCH_NOT_FOUND.",
        params: serviceOrderSchemas.businessIdParam,
        body: serviceOrderSchemas.createServiceOrder,
        response: {
          201: serviceOrderResponses.serviceOrderCreated,
          400: serviceOrderResponses.createServiceOrderErrors,
          404: serviceOrderResponses.createServiceOrderNotFound,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    createServiceOrderController.handle,
  );

  app.get(
    "/list-service-order",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [managerRead],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Lista as ordens de serviço da empresa",
        description:
          "Uma empresa por vez: o MASTER informa `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED); os demais usam a própria. Ordena no servidor (`sort`/`order`) e filtra por situação (`status`), tipo de manutenção (`maintenanceType`) e filial (`branchId`), cada filtro com um ou mais valores separados por vírgula, além da busca livre (ID, descrição, placa ou descrição do veículo, responsável, filial, fornecedor ou valor). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções dos filtros com as contagens, calculados sobre a empresa inteira. Cada ordem traz `parts_total` (soma das peças) e `accounts_payable_count` (contas vinculadas). Token de motorista recebe 403: ele vê as ordens do veículo que dirige por search-service-order-by-vehicle.",
        querystring: serviceOrderSchemas.listServiceOrder,
        response: {
          200: ndjsonList(
            itemOf(serviceOrderResponses.serviceOrderList),
            offsetMetaWith(serviceOrderResponses.serviceOrderSearchMeta),
          ),
          400: serviceOrderResponses.genericError,
          404: serviceOrderResponses.sessionUserNotFound,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    listServiceOrderController.handle,
  );

  app.get(
    "/export-service-order",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyPermission("service_order_manage", "write", {
          allowDriver: false,
        }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Exporta as ordens de serviço (CSV ou Excel)",
        description:
          "As mesmas linhas da listagem: a mesma busca e os mesmos filtros (`status`, `maintenanceType`, `branchId`), de uma empresa (o MASTER informa `businessId`). `format=csv|excel`. O arquivo leva a data do dia da empresa. Sem nenhuma ordem no filtro, 400 NOTHING_TO_EXPORT.",
        querystring: serviceOrderSchemas.exportServiceOrderQuery,
        response: {
          200: exportFileResponse("relatorio-ordens-servico-<AAAA-MM-DD>"),
          400: serviceOrderResponses.genericError,
          404: serviceOrderResponses.exportServiceOrderNotFound,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    exportServiceOrderController.handle,
  );

  app.get(
    "/search-service-order-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [managerRead],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Busca ordens de serviço da empresa (por cursor)",
        description:
          "Para os seletores: NDJSON com cursor, mais novas primeiro. `search` filtra por ID, descrição da ordem ou placa/descrição do veículo. " +
          "A primeira linha é {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; as seguintes, uma ordem por linha. " +
          "Passe nextCursor como `cursor` para a próxima página.",
        querystring: serviceOrderSchemas.searchServiceOrderBusinessCursor,
        response: {
          200: ndjsonCursor(itemOf(serviceOrderResponses.serviceOrderList)),
          400: serviceOrderResponses.listServiceOrderBusinessErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    searchServiceOrderCursorController.handle,
  );

  app.get(
    "/search-service-order-by-vehicle/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Histórico de ordens de serviço de um veículo (por cursor)",
        description:
          "NDJSON com cursor, mais novas primeiro. O motorista consulta o veículo que pode operar: aquele em que é o responsável ou o da sua rota liberada ou em andamento; outro veículo da empresa recebe 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER. " +
          "Veículo inexistente ou de outra empresa recebe 404 VEHICLE_NOT_FOUND (a resposta não confirma que ele existe). " +
          "A primeira linha é {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; as seguintes, uma ordem por linha. " +
          "Passe nextCursor como `cursor` para a próxima página.",
        params: serviceOrderSchemas.searchServiceOrderByVehicleParams,
        querystring: serviceOrderSchemas.searchServiceOrderByVehicleCursor,
        response: {
          200: ndjsonCursor(itemOf(serviceOrderResponses.serviceOrderList)),
          400: serviceOrderResponses.genericError,
          403: serviceOrderResponses.genericError,
          404: serviceOrderResponses.genericError,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    searchServiceOrderByVehicleCursorController.handle,
  );

  app.patch(
    "/update-service-order/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("service_order_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Atualiza uma ordem de serviço",
        description:
          "Edita os dados da ordem. Ao concluí-la, a nova quilometragem é obrigatória e pode ser igual à atual do veículo (só a última manutenção é gravada); menor é recusada (400 SERVICE_ORDER_MILEAGE_BEHIND). Numa ordem já concluída, a quilometragem gravada que volta sem mudança (o formulário envia todos os campos) não é conferida de novo nem regravada no veículo: o hodômetro segue depois dela, e a ordem continua editável. Uma quilometragem corrigida é conferida com a da abertura da ordem (menor, 400 SERVICE_ORDER_MILEAGE_BEHIND), não com o hodômetro de hoje; se esta ordem é a última manutenção do veículo, a última manutenção acompanha a correção e o hodômetro só avança (nunca volta); se houve manutenção depois, o veículo não muda e a correção não pode passar o hodômetro (400 SERVICE_ORDER_MILEAGE_AHEAD). Ordem inexistente ou de outra empresa, 404 SERVICE_ORDER_NOT_FOUND (a mesma resposta, que não confirma que o ID existe); vínculos do corpo seguem a regra da criação.",
        params: serviceOrderSchemas.serviceOrderBusinessParams,
        body: serviceOrderSchemas.updateServiceOrder,
        response: {
          200: serviceOrderResponses.serviceOrderUpdated,
          400: serviceOrderResponses.updateServiceOrderErrors,
          404: serviceOrderResponses.serviceOrderNotFound,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    updateServiceOrderController.handle,
  );

  app.delete(
    "/delete-service-order/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // A deactivated company is read-only (TENANT_INACTIVE), as on the
      // create and update beside it: a MASTER token names no company, so
      // nothing else stops this delete.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("service_order_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Exclui uma ordem de serviço",
        description:
          "Remove a ordem e as peças lançadas nela (a resposta diz quantas). Recusada com 409 quando uma conta a pagar aponta para ela (SERVICE_ORDER_HAS_ACCOUNTS_PAYABLE: a conta perderia a origem) ou quando ela está concluída (SERVICE_ORDER_COMPLETED: a quilometragem e a última manutenção do veículo já foram atualizadas e não voltam). A verificação e a exclusão acontecem sob trava da ordem. Ordem inexistente ou de outra empresa, 404 SERVICE_ORDER_NOT_FOUND (a mesma resposta, que não confirma que o ID existe).",
        params: serviceOrderSchemas.serviceOrderBusinessParams,
        response: {
          200: serviceOrderResponses.serviceOrderDeleted,
          400: serviceOrderResponses.deleteServiceOrderErrors,
          404: serviceOrderResponses.serviceOrderNotFound,
          409: serviceOrderResponses.serviceOrderConflict,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    deleteServiceOrderController.handle,
  );
}

export { serviceOrderRoutes };
