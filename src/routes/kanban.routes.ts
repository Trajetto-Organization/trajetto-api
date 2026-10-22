import { FastifyInstance } from "fastify";

import { CreateKanbanColumnController } from "@/modules/kanban/usecases/create-column/create-column-controller";
import { UpdateKanbanColumnController } from "@/modules/kanban/usecases/update-column/update-column-controller";

import { DeleteKanbanColumnController } from "@/modules/kanban/usecases/delete-column/delete-column-controller";

import { ListKanbanController } from "@/modules/kanban/usecases/list-kanban/list-kanban-controller";
import { ReorderKanbanColumnsController } from "@/modules/kanban/usecases/reorder-columns/reorder-columns-controller";

import { CreateKanbanCardController } from "@/modules/kanban/usecases/create-card/create-card-controller";
import { UpdateKanbanCardController } from "@/modules/kanban/usecases/update-card/update-card-controller";

import { DeleteKanbanCardController } from "@/modules/kanban/usecases/delete-card/delete-card-controller";
import { ReorderKanbanCardsController } from "@/modules/kanban/usecases/reorder-cards/reorder-cards-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  kanbanSchemas,
  kanbanResponses,
} from "./documentation/kanban-documentation";
import { ndjsonList } from "./documentation/ndjson";

const createKanbanColumnController = new CreateKanbanColumnController();
const updateKanbanColumnController = new UpdateKanbanColumnController();

const deleteKanbanColumnController = new DeleteKanbanColumnController();
const listKanbanController = new ListKanbanController();

const reorderKanbanColumnsController = new ReorderKanbanColumnsController();

const createKanbanCardController = new CreateKanbanCardController();
const updateKanbanCardController = new UpdateKanbanCardController();

const deleteKanbanCardController = new DeleteKanbanCardController();
const reorderKanbanCardsController = new ReorderKanbanCardsController();

/**
 * Said once for every Kanban write: a column or card of another company is
 * answered exactly as a missing one (404 with a code), never with a 403 that
 * would confirm the id exists on some other board (decision 11.3).
 */
const NOT_FOUND_RULE =
  " Uma coluna ou um card de outra empresa recebe a mesma resposta de um id inexistente (404 com código), nunca um 403 que confirmaria que o id existe em outro quadro.";

async function kanbanRoutes(app: FastifyInstance) {
  app.post(
    "/column/create/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("kanban_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Cria uma coluna no quadro da empresa",
        description:
          "Cria uma coluna com título e cor no fim do quadro da empresa. Colunas criadas ao mesmo tempo recebem posições distintas e sem buracos (a posição é calculada sob um lock do quadro).",
        params: kanbanSchemas.businessIdParam,
        body: kanbanSchemas.createColumn,
        response: {
          201: kanbanResponses.columnCreated,
          400: kanbanResponses.createColumnErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.createColumnNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    createKanbanColumnController.handle,
  );

  app.patch(
    "/column/update/:columnId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("kanban_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Atualiza uma coluna do quadro",
        description:
          "Altera o título ou a cor de uma coluna do quadro da empresa do caminho. Nem o MASTER edita uma coluna pelo caminho de outra empresa." +
          NOT_FOUND_RULE,
        params: kanbanSchemas.updateDeleteColumn,
        body: kanbanSchemas.updateColumn,
        response: {
          200: kanbanResponses.columnUpdated,
          400: kanbanResponses.updateColumnErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.columnWriteNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    updateKanbanColumnController.handle,
  );

  app.delete(
    "/column/delete/:columnId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Exclui uma coluna e os cards dela",
        description:
          "Exclui a coluna com todos os seus cards e fecha o buraco nas posições das demais, na mesma transação. Se a coluna for excluída por outra pessoa no meio, a resposta é 404." +
          NOT_FOUND_RULE,
        params: kanbanSchemas.updateDeleteColumn,
        response: {
          200: kanbanResponses.columnDeleted,
          400: kanbanResponses.deleteColumnErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.columnWriteNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    deleteKanbanColumnController.handle,
  );

  app.post(
    "/columns/reorder",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Reordena as colunas do quadro",
        description:
          "Grava a nova ordem das colunas do quadro da empresa informada. As posições precisam ser distintas; uma coluna inexistente ou de outra empresa recebe 404 (a mesma resposta para os dois casos).",
        body: kanbanSchemas.reorderColumns,
        response: {
          200: kanbanResponses.columnsReordered,
          400: kanbanResponses.reorderColumnsErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.reorderColumnsNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    reorderKanbanColumnsController.handle,
  );

  app.get(
    "/list/:businessId",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Lista o quadro Kanban da empresa",
        description:
          "Devolve em NDJSON as colunas do quadro (paginadas e com busca) e os cards de cada uma. Os cards de todas as colunas da página vêm numa consulta só. Com busca, a coluna encontrada pelo título mostra todos os cards; as demais, só os que batem (título, descrição, id, responsável ou prioridade em português). Quem não tem leitura completa do Kanban vê só as colunas com cards seus, e só esses cards.",
        params: kanbanSchemas.businessIdParam,
        querystring: kanbanSchemas.listKanban,
        response: {
          200: ndjsonList(kanbanResponses.kanbanList),
          400: kanbanResponses.listKanbanErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.listKanbanNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    listKanbanController.handle,
  );

  app.post(
    "/card/create",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Cria um card numa coluna",
        description:
          'Cria o card no fim da coluna (posições sem colisão mesmo com criações simultâneas). O responsável precisa ser da empresa do quadro, inclusive quando quem cria é o MASTER: o MASTER recebe "Este usuário não pertence a esta empresa!", os demais recebem "Usuário atribuído não encontrado.", como para um id inexistente.' +
          NOT_FOUND_RULE,
        body: kanbanSchemas.createCard,
        response: {
          201: kanbanResponses.cardCreated,
          400: kanbanResponses.createCardErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.createCardNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    createKanbanCardController.handle,
  );

  app.patch(
    "/card/update/:cardId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Atualiza um card",
        description:
          "Altera só os campos enviados do card. Trocar o responsável segue a mesma regra da criação: o responsável precisa ser da empresa do quadro, inclusive para o MASTER." +
          NOT_FOUND_RULE,
        params: kanbanSchemas.updateDeleteCard,
        body: kanbanSchemas.updateCard,
        response: {
          200: kanbanResponses.cardUpdated,
          400: kanbanResponses.updateCardErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.cardNotFound,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    updateKanbanCardController.handle,
  );

  app.delete(
    "/card/delete/:cardId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Exclui um card",
        description:
          "Exclui o card e fecha o buraco nas posições da coluna em que ele está no momento, sob o lock dessa coluna. Se o card mudar de coluna repetidas vezes durante a operação, a resposta é 409 KANBAN_BOARD_CHANGED." +
          NOT_FOUND_RULE,
        params: kanbanSchemas.updateDeleteCard,
        response: {
          200: kanbanResponses.cardDeleted,
          400: kanbanResponses.deleteCardErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.cardNotFound,
          409: kanbanResponses.boardChanged,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    deleteKanbanCardController.handle,
  );

  app.post(
    "/cards/reorder",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Reordena ou move cards entre colunas",
        description:
          "Grava a posição e a coluna de cada card enviado, sob o lock das colunas de origem e de destino. Um card nunca vai para o quadro de outra empresa (400 KANBAN_CARD_CROSS_BOARD_MOVE, que só o MASTER pode receber). Uma coluna excluída no meio da operação responde 404." +
          NOT_FOUND_RULE,
        body: kanbanSchemas.reorderCards,
        response: {
          200: kanbanResponses.cardsReordered,
          400: kanbanResponses.reorderCardsErrors,
          403: kanbanResponses.forbidden,
          404: kanbanResponses.cardNotFound,
          409: kanbanResponses.boardChanged,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    reorderKanbanCardsController.handle,
  );
}

export { kanbanRoutes };
