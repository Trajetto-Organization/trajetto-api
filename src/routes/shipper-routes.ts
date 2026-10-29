import { FastifyInstance } from "fastify";

import { CreateShipperController } from "@/modules/shipper/usecases/create-shipper/create-shipper-controller";
import { ListShipperController } from "@/modules/shipper/usecases/list-shipper/list-shipper-controller";

import { SearchShipperCursorController } from "@/modules/shipper/usecases/search-shipper-cursor/search-shipper-cursor-controller";
import { UpdateShipperController } from "@/modules/shipper/usecases/update-shipper/update-shipper-controller";
import { DeleteShipperController } from "@/modules/shipper/usecases/delete-shipper/delete-shipper-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  shipperSchemas,
  shipperResponses,
} from "./documentation/shipper-documentation";
import {
  itemOf,
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { shipperListSearchMetaDoc } from "@/modules/shipper/usecases/list-shipper/list-shipper-documentation";

const createShipperController = new CreateShipperController();
const listShipperController = new ListShipperController();

const searchShipperCursorController = new SearchShipperCursorController();
const updateShipperController = new UpdateShipperController();
const deleteShipperController = new DeleteShipperController();

// Every route lives behind the DELIVERIES entitlement — the first consumer
// of verifyModuleEnabled. Companies without the module get a 403.
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function shipperRoutes(app: FastifyInstance) {
  app.post(
    "/create-shipper/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Cria um embarcador",
        description:
          "Cadastra o dono da carga para quem a transportadora entrega. Nome e CNPJ são únicos na empresa (409 SHIPPER_NAME_TAKEN ou SHIPPER_CNPJ_TAKEN); o CNPJ passa pela validação dos dígitos verificadores. Emite `catalogChanged` (shipper) depois de gravar.",
        params: shipperSchemas.businessIdParam,
        body: shipperSchemas.createShipper,
        response: {
          201: shipperResponses.shipperCreated,
          400: shipperResponses.codedError,
          403: shipperResponses.codedError,
          404: shipperResponses.lookupNotFound,
          409: shipperResponses.codedError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    createShipperController.handle,
  );

  app.get(
    "/list-shipper",
    {
      onRequest: [ensureAuthenticated],
      // Company-wide catalogue with the shippers' contacts: not the driver's
      // to read (decision 4.4). The app never lists shippers.
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Lista os embarcadores",
        description:
          "Tabela paginada no servidor: ordena por `sort`/`order` (name, created_at, updated_at) e filtra por `status` (active, inactive), além da busca por id, nome, CNPJ (com ou sem máscara) ou e-mail. A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (com a busca, sem o filtro de status) e as opções do filtro com as contagens. Token de motorista recebe 403 PERMISSION_DENIED.",
        querystring: shipperSchemas.listShippers,
        response: {
          200: ndjsonList(
            itemOf(shipperResponses.shipperList),
            offsetMetaWith(shipperListSearchMetaDoc),
          ),
          400: shipperResponses.codedError,
          404: shipperResponses.lookupNotFound,
          500: shipperResponses.internalServerError,
        },
      },
    },
    listShipperController.handle,
  );

  app.get(
    "/search-shipper-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Busca embarcadores ativos (cursor)",
        description:
          'Embarcadores ATIVOS em NDJSON com paginação por cursor, para o seletor de cadastro de entregas, em ordem de nome. `search` filtra no servidor por nome, CNPJ (com ou sem máscara; um nome com dígitos, como "Loja 2", não vira busca de CNPJ) ou e-mail. Empresa inexistente responde 404 TENANT_NOT_FOUND, em JSON e antes de abrir o stream. ' +
          "A primeira linha traz {meta: {searchMeta: {nextCursor, hasMore}}}; as seguintes, os embarcadores. Token de motorista recebe 403 PERMISSION_DENIED.",
        querystring: shipperSchemas.searchShipperCursor,
        response: {
          200: ndjsonCursor(itemOf(shipperResponses.shipperList)),
          400: shipperResponses.codedError,
          404: shipperResponses.lookupNotFound,
          500: shipperResponses.internalServerError,
        },
      },
    },
    searchShipperCursorController.handle,
  );

  app.patch(
    "/update-shipper/:shipperId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Edita um embarcador",
        description:
          "Edita os dados ou liga/desliga `is_active`. Um embarcador desativado mantém o histórico e é recusado em novos cadastros, edições, XML e planilha. Embarcador inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND (a mesma resposta nos dois casos). Nome ou CNPJ de outro embarcador da empresa → 409 SHIPPER_NAME_TAKEN ou SHIPPER_CNPJ_TAKEN. Emite `catalogChanged` (shipper).",
        params: shipperSchemas.shipperBusinessParams,
        body: shipperSchemas.updateShipper,
        response: {
          200: shipperResponses.shipperUpdated,
          400: shipperResponses.codedError,
          403: shipperResponses.codedError,
          404: shipperResponses.shipperNotFound,
          409: shipperResponses.codedError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    updateShipperController.handle,
  );

  app.delete(
    "/delete-shipper/:shipperId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Same guard as create and update (DLV-SHP-7).
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Exclui um embarcador",
        description:
          "Remove um embarcador sem entregas; com entregas, ele deve ser desativado (409 SHIPPER_HAS_DELIVERIES: o histórico depende dele). Embarcador inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND. Empresa inativa recebe 403 TENANT_INACTIVE. Emite `catalogChanged` (shipper).",
        params: shipperSchemas.shipperBusinessParams,
        response: {
          200: shipperResponses.shipperDeleted,
          400: shipperResponses.codedError,
          403: shipperResponses.codedError,
          404: shipperResponses.shipperNotFound,
          409: shipperResponses.codedError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    deleteShipperController.handle,
  );
}

export { shipperRoutes };
