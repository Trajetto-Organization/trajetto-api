import { FastifyInstance } from "fastify";

import { CreateDriverController } from "@/modules/driver/usecases/create-driver/create-driver-controller";
import { ListDriverController } from "@/modules/driver/usecases/list-driver/list-driver-controller";

import { UpdateDriverController } from "@/modules/driver/usecases/update-driver/update-driver-controller";
import { DeleteDriverController } from "@/modules/driver/usecases/delete-driver/delete-driver-controller";

import { ExportDriverController } from "@/modules/driver/usecases/export-driver/export-driver-controller";
import { SearchDriverCursorController } from "@/modules/driver/usecases/search-driver-cursor/search-driver-cursor-controller";
import { verifyDriverPickerAccess } from "@/modules/driver/usecases/search-driver-cursor/driver-picker-access";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  driverSchemas,
  driverResponses,
} from "./documentation/driver-documentation";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";

const createDriverController = new CreateDriverController();
const listDriverController = new ListDriverController();

const exportDriverController = new ExportDriverController();
const searchDriverCursorController = new SearchDriverCursorController();

const updateDriverController = new UpdateDriverController();
const deleteDriverController = new DeleteDriverController();

async function driverRoutes(app: FastifyInstance) {
  app.post(
    "/create-driver/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("driver_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Cadastra um motorista",
        description:
          "Cadastra um motorista na empresa do caminho: dados pessoais, endereço, CNH (número, categoria e validade — as duas últimas opcionais, a validade como data civil AAAA-MM-DD) e, opcionalmente, a filial. CPF e CNH são únicos POR EMPRESA (decisão 8.1): o mesmo motorista autônomo pode trabalhar para duas transportadoras, e o 409 nunca revela cadastro de outra. Avisa as telas abertas da empresa (`catalogChanged`, entidade `driver`).",
        params: driverSchemas.businessIdParam,
        body: driverSchemas.createDriver,
        response: {
          201: driverResponses.driverCreated,
          400: driverResponses.validationErrors,
          403: driverResponses.writeForbidden,
          404: driverResponses.notFound,
          409: driverResponses.writeConflicts,
          500: driverResponses.internalServerError,
        },
      },
    },
    createDriverController.handle,
  );

  app.get(
    "/list-driver",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Lista os motoristas de uma empresa",
        description:
          "Os motoristas de UMA empresa, paginados. O MASTER informa `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED); os demais usam a própria empresa. Ordena no servidor (`sort`/`order`) e filtra por situação, tipo de contrato, categoria da CNH e filial, cada filtro com um ou mais valores separados por vírgula, além da busca livre (nome, CNH, CPF, RG, CEP, endereço ou IDs). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções dos filtros com as contagens, calculados sobre a empresa inteira. Cada motorista traz `cnh_status`, a situação da CNH no dia de negócio da empresa.",
        querystring: driverSchemas.listDriver,
        response: {
          200: ndjsonList(
            driverResponses.driverListItem,
            offsetMetaWith(driverResponses.driverListSearchMeta),
          ),
          400: driverResponses.validationErrors,
          403: driverResponses.forbidden,
          404: driverResponses.notFound,
          500: driverResponses.internalServerError,
        },
      },
    },
    listDriverController.handle,
  );

  app.get(
    "/export-driver",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Exporta os motoristas (CSV ou Excel)",
        description:
          "Exporta os motoristas de UMA empresa com a mesma busca, os mesmos filtros e a mesma ordem da listagem (decisão 5.8). `format=csv|excel`. O MASTER informa `businessId`. O nome do arquivo leva o dia de negócio da empresa.",
        querystring: driverSchemas.exportDriverQuery,
        response: {
          200: exportFileResponse("relatorio-motoristas-<AAAA-MM-DD>"),
          400: driverResponses.exportErrors,
          403: driverResponses.forbidden,
          404: driverResponses.notFound,
          500: driverResponses.internalServerError,
        },
      },
    },
    exportDriverController.handle,
  );

  app.get(
    "/search-driver-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyDriverPickerAccess],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Busca motoristas ativos para seleção (cursor)",
        description:
          "Os motoristas ATIVOS de uma empresa para os seletores, em ordem alfabética, por cursor (`meta.searchMeta.nextCursor`/`hasMore`), com busca pelo nome (e pela CNH, para quem lê o cadastro). Aceita `driver_manage` (leitura) OU `delivery_manage` (escrita): o despachante escolhe o motorista da rota sem ler o cadastro de motoristas (decisão 4.7) e recebe só os campos da escolha — nome, situação, categoria e validade da CNH —, sem documentos. Token de motorista é recusado.",
        querystring: driverSchemas.searchDriverCursor,
        response: {
          200: ndjsonCursor(driverResponses.driverPickerItem),
          400: driverResponses.validationErrors,
          403: driverResponses.forbidden,
          404: driverResponses.notFound,
          500: driverResponses.internalServerError,
        },
      },
    },
    searchDriverCursorController.handle,
  );

  app.patch(
    "/update-driver/:driverId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("driver_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Edita um motorista",
        description:
          "Edita os dados do motorista da empresa do caminho. Inativar um motorista com rota planejada, liberada ou em andamento é recusado com 409 DRIVER_HAS_OPEN_ROUTES e a contagem (decisão 8.3): a rota em andamento precisa terminar ou ser cancelada, e as outras, ir para outro motorista ou ser canceladas. Motorista de outra empresa responde 404, como um inexistente. Avisa as telas abertas da empresa (`catalogChanged`, entidade `driver`).",
        params: driverSchemas.driverBusinessParams,
        body: driverSchemas.updateDriver,
        response: {
          200: driverResponses.driverUpdated,
          400: driverResponses.validationErrors,
          403: driverResponses.writeForbidden,
          404: driverResponses.notFound,
          409: driverResponses.writeConflicts,
          500: driverResponses.internalServerError,
        },
      },
    },
    updateDriverController.handle,
  );

  app.delete(
    "/delete-driver/:driverId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Same guard as create and update: a deactivated company is read-only,
      // for the MASTER too (403 TENANT_INACTIVE).
      preHandler: [
        verifyBusinessActive,
        verifyPermission("driver_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Exclui um motorista",
        description:
          "Exclui de vez um motorista SEM histórico. Com usuário vinculado, multas, abastecimentos, checklists, entregas, rotas ou pausas registradas, responde 409 com o código do primeiro motivo encontrado e a quantidade dele: inative o motorista em vez de excluir. As conversas do chat com ele, se houver, são apagadas junto. Motorista de outra empresa responde 404, como um inexistente. Empresa desativada responde 403 TENANT_INACTIVE.",
        params: driverSchemas.driverBusinessParams,
        response: {
          200: driverResponses.driverDeleted,
          400: driverResponses.validationErrors,
          403: driverResponses.writeForbidden,
          404: driverResponses.notFound,
          409: driverResponses.deleteConflicts,
          500: driverResponses.internalServerError,
        },
      },
    },
    deleteDriverController.handle,
  );
}

export { driverRoutes };
