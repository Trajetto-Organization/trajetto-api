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

import {
  kanbanSchemas,
  kanbanResponses,
} from "./documentation/kanban-documentation";

const createKanbanColumnController = new CreateKanbanColumnController();
const updateKanbanColumnController = new UpdateKanbanColumnController();

const deleteKanbanColumnController = new DeleteKanbanColumnController();
const listKanbanController = new ListKanbanController();

const reorderKanbanColumnsController = new ReorderKanbanColumnsController();

const createKanbanCardController = new CreateKanbanCardController();
const updateKanbanCardController = new UpdateKanbanCardController();

const deleteKanbanCardController = new DeleteKanbanCardController();
const reorderKanbanCardsController = new ReorderKanbanCardsController();

async function kanbanRoutes(app: FastifyInstance) {
  app.post(
    "/column/create/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Create a new kanban column",
        description:
          "Create a new kanban board column with title, color, and position for organizing workflow tasks",
        params: kanbanSchemas.businessIdParam,
        body: kanbanSchemas.createColumn,
        response: {
          201: kanbanResponses.columnCreated,
          400: kanbanResponses.createColumnErrors,
          403: kanbanResponses.kanbanNotAllowedCreateColumn,
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
      preHandler: [verifyPermission("kanban_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["kanban"],
        summary: "Update a kanban column",
        description:
          "Update existing kanban column information including title, color, and visual properties",
        params: kanbanSchemas.updateDeleteColumn,
        body: kanbanSchemas.updateColumn,
        response: {
          200: kanbanResponses.columnUpdated,
          400: kanbanResponses.updateColumnErrors,
          403: kanbanResponses.updateColumnForbiddenErrors,
          404: kanbanResponses.kanbanColumnNotFound,
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
        summary: "Delete a kanban column",
        description:
          "Permanently remove a kanban column and all associated cards from the board",
        params: kanbanSchemas.updateDeleteColumn,
        response: {
          200: kanbanResponses.columnDeleted,
          400: kanbanResponses.deleteColumnErrors,
          403: kanbanResponses.deleteColumnForbiddenErrors,
          404: kanbanResponses.kanbanColumnNotFound,
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
        summary: "Reorder kanban columns",
        description:
          "Change the position and order of kanban columns on the board for better workflow organization",
        body: kanbanSchemas.reorderColumns,
        response: {
          200: kanbanResponses.columnsReordered,
          400: kanbanResponses.reorderColumnsErrors,
          403: kanbanResponses.kanbanNotAllowedReorderColumn,
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
        summary: "List kanban board",
        description:
          "Retrieve complete kanban board with all columns, cards, and task assignments for a specific business",
        params: kanbanSchemas.businessIdParam,
        querystring: kanbanSchemas.listKanban,
        response: {
          200: kanbanResponses.kanbanList,
          400: kanbanResponses.listKanbanErrors,
          403: kanbanResponses.kanbanNotAllowedViewBoard,
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
        summary: "Create a new kanban card",
        description:
          "Create a new task card with title, description, priority, due date, and assignment details",
        body: kanbanSchemas.createCard,
        response: {
          201: kanbanResponses.cardCreated,
          400: kanbanResponses.createCardErrors,
          403: kanbanResponses.kanbanNotAllowedCreateCard,
          404: kanbanResponses.kanbanColumnNotFound,
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
        summary: "Update a kanban card",
        description:
          "Update existing task card information including content, priority, completion status, and assignments",
        params: kanbanSchemas.updateDeleteCard,
        body: kanbanSchemas.updateCard,
        response: {
          200: kanbanResponses.cardUpdated,
          400: kanbanResponses.updateCardErrors,
          403: kanbanResponses.kanbanNotAllowedUpdateCard,
          404: kanbanResponses.updateCardNotFoundErrors,
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
        summary: "Delete a kanban card",
        description: "Permanently remove a task card from the kanban board",
        params: kanbanSchemas.updateDeleteCard,
        response: {
          200: kanbanResponses.cardDeleted,
          400: kanbanResponses.resourceNotFound,
          403: kanbanResponses.kanbanNotAllowedDeleteCard,
          404: kanbanResponses.deleteCardNotFoundErrors,
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
        summary: "Reorder kanban cards",
        description:
          "Change the position and order of task cards within columns or move cards between different columns",
        body: kanbanSchemas.reorderCards,
        response: {
          200: kanbanResponses.cardsReordered,
          400: kanbanResponses.reorderCardsErrors,
          403: kanbanResponses.kanbanNotAllowedReorderCard,
          500: kanbanResponses.internalServerError,
        },
      },
    },
    reorderKanbanCardsController.handle,
  );
}

export { kanbanRoutes };
