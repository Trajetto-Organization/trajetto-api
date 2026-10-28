import { FastifyInstance } from "fastify";

import { CreateVehicleController } from "@/modules/vehicle/usecases/create-vehicle/create-vehicle-controller";
import { ListVehicleController } from "@/modules/vehicle/usecases/list-vehicle/list-vehicle-controller";

import { UpdateVehicleController } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-controller";
import { DeleteVehicleController } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-controller";

import { ExportVehicleController } from "@/modules/vehicle/usecases/export-vehicle/export-vehicle-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  vehicleSchemas,
  vehicleResponses,
  vehicleListSearchMetaDoc,
} from "./documentation/vehicle-documentation";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";

import { GetVehicleController } from "@/modules/vehicle/usecases/get-vehicle/get-vehicle-controller";
import { SearchVehicleCursorController } from "@/modules/vehicle/usecases/search-vehicle-cursor/search-vehicle-cursor-controller";
import { vehiclePickerGuard } from "@/modules/vehicle/usecases/search-vehicle-cursor/vehicle-picker-access";

const createVehicleController = new CreateVehicleController();
const listVehicleController = new ListVehicleController();

const exportVehicleController = new ExportVehicleController();

const getVehicleController = new GetVehicleController();
const searchVehicleCursorController = new SearchVehicleCursorController();

const updateVehicleController = new UpdateVehicleController();
const deleteVehicleController = new DeleteVehicleController();

async function vehicleRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Cadastra um veículo",
        description:
          "Cadastra um veículo na frota da empresa. Placa (normalizada para maiúsculas) e RENAVAM são únicos por empresa; a recusa diz só que já existem nesta empresa. Respeita a frota contratada: com o limite atingido, responde 409 VEHICLE_LIMIT_REACHED com a contagem. O status inicial é ACTIVE, INACTIVE ou BLOCKED (IN_ROUTE é escrito pela rota).",
        params: vehicleSchemas.businessIdParam,
        body: vehicleSchemas.createVehicle,
        response: {
          201: vehicleResponses.vehicleCreated,
          400: vehicleResponses.validationError,
          404: vehicleResponses.notFound,
          409: vehicleResponses.createConflict,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    createVehicleController.handle,
  );

  app.get(
    "/list-vehicle",
    {
      onRequest: [ensureAuthenticated],
      // Drivers are refused (decision 4.4): the grant is for the vehicle
      // they drive, which their app reads through the search.
      preHandler: [
        verifyPermission("vehicle_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Lista os veículos da empresa",
        description:
          "Frota de UMA empresa, paginada: o MASTER informa `businessId`; os demais veem a própria. Ordena no servidor (`sort`/`order`) e filtra por status e filial (um ou mais valores separados por vírgula), além da busca livre (ID, descrição, placa, marca, modelo, RENAVAM, identificador da frota, motorista, tipo ou filial). O ID vale inteiro ou só o final que a tabela mostra (pelo menos 8 caracteres hexadecimais). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões por status e as opções dos filtros com as contagens. Motoristas não usam esta rota.",
        querystring: vehicleSchemas.listVehicle,
        response: {
          200: ndjsonList(
            vehicleResponses.vehicleListItem,
            offsetMetaWith(vehicleListSearchMetaDoc),
          ),
          400: vehicleResponses.validationError,
          403: vehicleResponses.forbidden,
          404: vehicleResponses.sessionUserNotFound,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    listVehicleController.handle,
  );

  app.get(
    "/export-vehicle",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Exporta os veículos (CSV ou Excel)",
        description:
          "Exporta a mesma lista da tela: a mesma busca e os mesmos filtros de status e filial, da empresa escolhida (`businessId`, só o MASTER) ou da própria. `format=csv|excel`.",
        querystring: vehicleSchemas.exportVehicleQuery,
        response: {
          200: exportFileResponse("relatorio-veiculos-<AAAA-MM-DD>"),
          400: vehicleResponses.exportError,
          404: vehicleResponses.notFound,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    exportVehicleController.handle,
  );

  app.get(
    "/search-vehicle-business",
    {
      onRequest: [ensureAuthenticated],
      // vehicle_manage:read, or delivery_manage:write for the dispatcher's
      // assignment combobox (DLV-COMBO-1) with only the choice fields.
      preHandler: [vehiclePickerGuard],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Busca veículos para seleção (cursor)",
        description:
          "Veículos ATIVOS ou EM ROTA da empresa, por cursor, com busca no servidor (descrição, placa, marca, modelo, RENAVAM). Aceita quem tem leitura de veículos (cadastro inteiro) ou escrita de Entregas (despacho: só os campos da escolha — placa, descrição, status, motorista responsável). Para o motorista, só os veículos que ele pode operar: o que está sob sua responsabilidade e o da rota liberada ou em andamento dele.",
        querystring: vehicleSchemas.searchVehicleCursor,
        response: {
          200: ndjsonCursor(vehicleResponses.vehicleSearchItem),
          400: vehicleResponses.validationError,
          403: vehicleResponses.forbidden,
          404: vehicleResponses.notFound,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    searchVehicleCursorController.handle,
  );

  app.get(
    "/get-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Consulta um veículo",
        description:
          "Um veículo da empresa, com a quilometragem e a data do último abastecimento. O motorista só consulta o veículo que pode operar (responsável ou da rota liberada ou em andamento dele).",
        params: vehicleSchemas.getVehicle,
        response: {
          200: vehicleResponses.vehicleReturned,
          400: vehicleResponses.validationError,
          403: vehicleResponses.forbidden,
          404: vehicleResponses.notFound,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    getVehicleController.handle,
  );

  app.patch(
    "/update-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Atualiza um veículo",
        description:
          "Atualiza só os campos enviados (as mesmas regras do cadastro). A quilometragem atual só é corrigida pelo MASTER. Status: IN_ROUTE é da rota; com rota em andamento só é possível bloquear; inativar com rota planejada, liberada ou em andamento é recusado com as contagens; reativar respeita a frota contratada.",
        params: vehicleSchemas.vehicleBusinessParams,
        body: vehicleSchemas.updateVehicle,
        response: {
          200: vehicleResponses.vehicleUpdated,
          400: vehicleResponses.validationError,
          404: vehicleResponses.notFound,
          409: vehicleResponses.updateConflict,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    updateVehicleController.handle,
  );

  app.delete(
    "/delete-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Exclui um veículo",
        description:
          "Exclui um veículo sem histórico. Com multas, abastecimentos, OS, checklists, contas a pagar, entregas ou rotas, responde 409 VEHICLE_IN_USE com a contagem; inativar é o caminho para um veículo que saiu da frota.",
        params: vehicleSchemas.vehicleBusinessParams,
        response: {
          200: vehicleResponses.vehicleDeleted,
          404: vehicleResponses.notFound,
          409: vehicleResponses.deleteConflict,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    deleteVehicleController.handle,
  );
}

export { vehicleRoutes };
