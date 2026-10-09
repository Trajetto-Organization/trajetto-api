import { FastifyInstance } from "fastify";

import { CreatePartController } from "@/modules/part/usecases/create-part/create-part-controller";
import { ListPartController } from "@/modules/part/usecases/list-part/list-part-controller";

import { SearchPartCursorController } from "@/modules/part/usecases/search-part-cursor/search-part-cursor-controller";

import { UpdatePartController } from "@/modules/part/usecases/update-part/update-part-controller";
import { DeletePartController } from "@/modules/part/usecases/delete-part/delete-part-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { partSchemas, partResponses } from "./documentation/part-documentation";
import {
  itemOf,
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

const createPartController = new CreatePartController();
const listPartController = new ListPartController();

const searchPartCursorController = new SearchPartCursorController();

const updatePartController = new UpdatePartController();
const deletePartController = new DeletePartController();

async function partRoutes(app: FastifyInstance) {
  // Maintenance supply chain, only meaningful with fleet operations —
  // gated for the whole plugin.
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-part/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Cadastra uma peça",
        description:
          "Cadastra uma peça no catálogo da empresa, com preço unitário e fornecedor opcional (da mesma empresa; inexistente ou de outra empresa, 400 SUPPLIER_NOT_FOUND, a mesma resposta nos dois casos). A descrição é única por empresa, sem diferenciar maiúsculas nem espaços nas pontas (409 PART_ALREADY_EXISTS). Avisa as telas abertas da empresa (catalogChanged `part`).",
        params: partSchemas.businessIdParam,
        body: partSchemas.createPart,
        response: {
          201: partResponses.partCreated,
          400: partResponses.createPartErrors,
          404: partResponses.partLookupNotFound,
          409: partResponses.partConflict,
          500: partResponses.internalServerError,
        },
      },
    },
    createPartController.handle,
  );

  app.get(
    "/list-part",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Lista o catálogo de peças da empresa",
        description:
          "Uma empresa por vez: o MASTER informa `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED). Ordena no servidor (`sort`/`order`), filtra por fornecedor (`supplierId`, um ou mais separados por vírgula) e busca por ID, descrição ou nome do fornecedor. A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções do filtro com as contagens, calculados sobre o catálogo inteiro. Cada peça traz `service_order_parts_count`.",
        querystring: partSchemas.listPart,
        response: {
          200: ndjsonList(
            itemOf(partResponses.partList),
            offsetMetaWith(partResponses.partSearchMeta),
          ),
          400: partResponses.listPartErrors,
          404: partResponses.sessionUserNotFound,
          500: partResponses.internalServerError,
        },
      },
    },
    listPartController.handle,
  );

  app.get(
    "/search-part-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Busca peças da empresa (por cursor)",
        description:
          "Para os seletores: NDJSON com cursor, mais novas primeiro. `search` filtra pela descrição da peça ou pelo nome do fornecedor. " +
          "A primeira linha é {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; as seguintes, uma peça por linha. " +
          "Passe nextCursor como `cursor` para a próxima página.",
        querystring: partSchemas.searchPartCursor,
        response: {
          200: ndjsonCursor(itemOf(partResponses.partList)),
          400: partResponses.partBusinessErrors,
          404: partResponses.partLookupNotFound,
          500: partResponses.internalServerError,
        },
      },
    },
    searchPartCursorController.handle,
  );

  app.patch(
    "/update-part/:partId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Atualiza uma peça",
        description:
          "Edita descrição, preço unitário e fornecedor. Mudar só a caixa da própria descrição é permitido; repetir a de outra peça da empresa, 409 PART_ALREADY_EXISTS. O preço já lançado nas ordens de serviço não muda (cada lançamento guarda o seu). Peça inexistente ou de outra empresa, 404 PART_NOT_FOUND — a mesma resposta, que não confirma que o ID existe; o mesmo vale para o fornecedor (400 SUPPLIER_NOT_FOUND). A empresa da peça não muda (400 PART_BUSINESS_READ_ONLY).",
        params: partSchemas.partBusinessParams,
        body: partSchemas.updatePart,
        response: {
          200: partResponses.partUpdated,
          400: partResponses.updatePartErrors,
          404: partResponses.partNotFound,
          409: partResponses.partConflict,
          500: partResponses.internalServerError,
        },
      },
    },
    updatePartController.handle,
  );

  app.delete(
    "/delete-part/:partId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // A deactivated company is read-only (TENANT_INACTIVE), as on the
      // create and update beside it: a MASTER token names no company, so
      // nothing else stops this delete.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Exclui uma peça",
        description:
          "Remove a peça do catálogo. Recusada com 409 PART_IN_USE quando algum lançamento de ordem de serviço a usa (a mensagem diz quantos). Peça inexistente ou de outra empresa, 404 PART_NOT_FOUND — a mesma resposta, que não confirma que o ID existe.",
        params: partSchemas.partBusinessParams,
        response: {
          200: partResponses.partDeleted,
          400: partResponses.deletePartErrors,
          404: partResponses.partNotFound,
          409: partResponses.partConflict,
          500: partResponses.internalServerError,
        },
      },
    },
    deletePartController.handle,
  );
}

export { partRoutes };
