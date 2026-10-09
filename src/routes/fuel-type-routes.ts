import { FastifyInstance } from "fastify";

import { CreateFuelTypeController } from "@/modules/fuel-type/usecases/create-fuel-type/create-fuel-type-controller";
import { ListFuelTypeController } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-controller";

import { UpdateFuelTypeController } from "@/modules/fuel-type/usecases/update-fuel-type/update-fuel-type-controller";
import { DeleteFuelTypeController } from "@/modules/fuel-type/usecases/delete-fuel-type/delete-fuel-type-controller";

import { SearchFuelTypeCursorController } from "@/modules/fuel-type/usecases/search-fuel-type-cursor/search-fuel-type-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  fuelTypeSchemas,
  fuelTypeResponses,
} from "./documentation/fuel-type-documentation";
import { itemOf, ndjsonCursor, ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { fuelTypeListSearchMetaDoc } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-documentation";
import { errorResponse } from "./documentation/common-responses";

import { listFuelTypeSchema } from "@/schemas/list-fuel-type-schema";

const createFuelTypeController = new CreateFuelTypeController();
const listFuelTypeController = new ListFuelTypeController();

const searchFuelTypeCursorController = new SearchFuelTypeCursorController();

const updateFuelTypeController = new UpdateFuelTypeController();
const deleteFuelTypeController = new DeleteFuelTypeController();

async function fuelTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-fuel-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fuel_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel-type"],
        summary: "Cadastra um tipo de combustível",
        description:
          "Cadastra um tipo de combustível (Gasolina, Diesel, Etanol, GNV, GLP, Biodiesel, Elétrico ou Hidrogênio) na empresa. Cada combustível existe uma vez por empresa (409 se já existir). Avisa as telas abertas da empresa pelo evento `catalogChanged` (`fuel_type`).",
        params: fuelTypeSchemas.businessIdParam,
        body: fuelTypeSchemas.createFuelType,
        response: {
          201: fuelTypeResponses.fuelTypeCreated,
          400: fuelTypeResponses.writeErrors,
          403: errorResponse,
          404: fuelTypeResponses.businessNotFound,
          409: fuelTypeResponses.alreadyExists,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    createFuelTypeController.handle,
  );

  app.get(
    "/list-fuel-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel-type"],
        summary: "Lista os tipos de combustível da empresa",
        description:
          "Tipos de combustível de uma empresa, paginados, com ordenação no servidor (`sort` = created_at, description ou updated_at; `order` = asc ou desc) e busca por ID ou nome. O MASTER informa `businessId`; os demais veem a própria empresa. A linha `meta.searchMeta` traz os cartões da tela sobre toda a busca: total, veículos por combustível e, para quem lê Abastecimentos numa empresa com Gestão de Frotas, os abastecimentos do mês de negócio (litros, valor e o combustível mais abastecido com o preço médio por litro).",
        querystring: listFuelTypeSchema,
        response: {
          200: ndjsonList(
            itemOf(fuelTypeResponses.fuelTypeList),
            offsetMetaWith(fuelTypeListSearchMetaDoc),
          ),
          400: fuelTypeResponses.listErrors,
          403: errorResponse,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    listFuelTypeController.handle,
  );

  app.get(
    "/search-fuel-type-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel-type"],
        summary: "Busca tipos de combustível para seleção (cursor)",
        description:
          "Tipos de combustível da empresa em NDJSON paginado por cursor, do mais recente ao mais antigo, filtrados pelo termo digitado (`search`). " +
          "A primeira linha traz `{meta: {searchMeta: {nextCursor, hasMore}}}`; as seguintes, um tipo cada. " +
          "Envie `nextCursor` como `cursor` para a próxima página.",
        querystring: fuelTypeSchemas.searchFuelTypeCursor,
        response: {
          200: ndjsonCursor(itemOf(fuelTypeResponses.fuelTypeList)),
          400: fuelTypeResponses.searchErrors,
          403: errorResponse,
          404: fuelTypeResponses.businessNotFound,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    searchFuelTypeCursorController.handle,
  );

  app.patch(
    "/update-fuel-type/:fuelTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fuel_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel-type"],
        summary: "Atualiza um tipo de combustível",
        description:
          "Troca o combustível de um tipo da empresa informada no caminho. O tipo nunca muda de empresa (seus veículos e abastecimentos ficariam em outra). Tipo de outra empresa responde 404; nome já usado na empresa, 409. Avisa as telas abertas pelo evento `catalogChanged` (`fuel_type`).",
        params: fuelTypeSchemas.fuelTypeBusinessParams,
        body: fuelTypeSchemas.updateFuelType,
        response: {
          200: fuelTypeResponses.fuelTypeUpdated,
          400: fuelTypeResponses.writeErrors,
          403: errorResponse,
          404: fuelTypeResponses.fuelTypeNotFound,
          409: fuelTypeResponses.updateConflict,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    updateFuelTypeController.handle,
  );

  app.delete(
    "/delete-fuel-type/:fuelTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Read-only for a deactivated company, like create and update.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fuel_type_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel-type"],
        summary: "Exclui um tipo de combustível",
        description:
          "Exclui um tipo de combustível sem uso. Com veículos ou abastecimentos associados a exclusão é recusada com a contagem (409), para não apagar de que combustível era cada registro. Tipo de outra empresa responde 404. Avisa as telas abertas pelo evento `catalogChanged` (`fuel_type`).",
        params: fuelTypeSchemas.fuelTypeBusinessParams,
        response: {
          200: fuelTypeResponses.fuelTypeDeleted,
          400: fuelTypeResponses.writeErrors,
          403: errorResponse,
          404: fuelTypeResponses.fuelTypeNotFound,
          409: fuelTypeResponses.deleteConflict,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    deleteFuelTypeController.handle,
  );
}

export { fuelTypeRoutes };
