import { FastifyInstance } from "fastify";

import { CreateVehicleTypeController } from "@/modules/vehicle-type/usecases/create-vehicle-type/create-vehicle-type-controller";
import { ListVehicleTypeController } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-controller";

import { UpdateVehicleTypeController } from "@/modules/vehicle-type/usecases/update-vehicle-type/update-vehicle-type-controller";
import { DeleteVehicleTypeController } from "@/modules/vehicle-type/usecases/delete-vehicle-type/delete-vehicle-type-controller";

import { SearchVehicleTypeCursorController } from "@/modules/vehicle-type/usecases/search-vehicle-type-cursor/search-vehicle-type-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  vehicleTypeSchemas,
  vehicleTypeResponses,
} from "./documentation/vehicle-type-documentation";
import { ndjsonCursor, ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { vehicleTypeListSearchMetaDoc } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-documentation";

const createVehicleTypeController = new CreateVehicleTypeController();
const listVehicleTypeController = new ListVehicleTypeController();

const searchVehicleTypeCursorController =
  new SearchVehicleTypeCursorController();

const updateVehicleTypeController = new UpdateVehicleTypeController();
const deleteVehicleTypeController = new DeleteVehicleTypeController();

async function vehicleTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-type"],
        summary: "Cadastra um tipo de veículo",
        description:
          "Cadastra um tipo de veículo da empresa: nome (único na empresa, sem diferenciar maiúsculas), eixos padrão e, opcionalmente, a categoria de CNH exigida para dirigi-lo (decisão 8.5; a atribuição de rota avisa, não bloqueia).",
        params: vehicleTypeSchemas.businessIdParam,
        body: vehicleTypeSchemas.createVehicleType,
        response: {
          201: vehicleTypeResponses.vehicleTypeCreated,
          400: vehicleTypeResponses.validationError,
          404: vehicleTypeResponses.notFound,
          409: vehicleTypeResponses.nameConflict,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    createVehicleTypeController.handle,
  );

  app.get(
    "/list-vehicle-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-type"],
        summary: "Lista os tipos de veículo da empresa",
        description:
          "Tipos de veículo de UMA empresa, paginados: o MASTER informa `businessId`; os demais veem a própria. Ordena no servidor (`sort`/`order`) e busca por ID, nome ou número de eixos. Cada linha traz em `_count.vehicles` quantos veículos usam o tipo; a linha `meta.searchMeta` traz os cartões da tela sobre toda a busca (não só a página): total de tipos, veículos cadastrados, tipos sem veículos e o tipo mais usado.",
        querystring: vehicleTypeSchemas.listVehicleType,
        response: {
          200: ndjsonList(
            vehicleTypeResponses.vehicleTypeListItem,
            offsetMetaWith(vehicleTypeListSearchMetaDoc),
          ),
          400: vehicleTypeResponses.validationError,
          404: vehicleTypeResponses.sessionUserNotFound,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    listVehicleTypeController.handle,
  );

  app.get(
    "/search-vehicle-type-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-type"],
        summary: "Busca tipos de veículo para seleção (cursor)",
        description:
          "Tipos de veículo da empresa, por cursor, com busca no servidor pelo nome (`search`). A primeira linha traz `meta.searchMeta.{nextCursor, hasMore}`.",
        querystring: vehicleTypeSchemas.searchVehicleTypeCursor,
        response: {
          200: ndjsonCursor(vehicleTypeResponses.vehicleTypeItem),
          400: vehicleTypeResponses.validationError,
          404: vehicleTypeResponses.notFound,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    searchVehicleTypeCursorController.handle,
  );

  app.patch(
    "/update-vehicle-type/:vehicleTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-type"],
        summary: "Atualiza um tipo de veículo",
        description:
          "Atualiza só os campos enviados. `required_cnh_category: null` remove a exigência. O tipo continua na empresa do caminho; um tipo de outra empresa responde 404.",
        params: vehicleTypeSchemas.vehicleTypeBusinessParams,
        body: vehicleTypeSchemas.updateVehicleType,
        response: {
          200: vehicleTypeResponses.vehicleTypeUpdated,
          400: vehicleTypeResponses.validationError,
          404: vehicleTypeResponses.notFound,
          409: vehicleTypeResponses.nameConflict,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    updateVehicleTypeController.handle,
  );

  app.delete(
    "/delete-vehicle-type/:vehicleTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-type"],
        summary: "Exclui um tipo de veículo",
        description:
          "Exclui um tipo sem veículos. Com veículos cadastrados nele, responde 409 VEHICLE_TYPE_IN_USE com a contagem (antes, a exclusão tirava o tipo desses veículos em silêncio).",
        params: vehicleTypeSchemas.vehicleTypeBusinessParams,
        response: {
          200: vehicleTypeResponses.vehicleTypeDeleted,
          404: vehicleTypeResponses.notFound,
          409: vehicleTypeResponses.deleteConflict,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    deleteVehicleTypeController.handle,
  );
}

export { vehicleTypeRoutes };
