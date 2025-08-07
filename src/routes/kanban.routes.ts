import { FastifyInstance } from "fastify";

import { CreateKanbanColumnController } from "@/modules/kanban/usecases/create-column/create-column-controller";
import { UpdateKanbanColumnController } from "@/modules/kanban/usecases/update-column/update-column-controller";

import { DeleteKanbanColumnController } from "@/modules/kanban/usecases/delete-column/delete-column-controller";

import { ListKanbanController } from "@/modules/kanban/usecases/list-kanban/list-kanban-controller";
import { ReorderKanbanColumnsController } from "@/modules/kanban/usecases/reorder-columns/reorder--columns-controller";

import { CreateKanbanCardController } from "@/modules/kanban/usecases/create-card/create-card-controller";
import { UpdateKanbanCardController } from "@/modules/kanban/usecases/update-card/update-card-controller";

import { DeleteKanbanCardController } from "@/modules/kanban/usecases/delete-card/delete-card-controller";
import { ReorderKanbanCardsController } from "@/modules/kanban/usecases/reorder-cards/reorder-cards-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

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
        description: "Create a new kanban column",
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
        description: "Update a kanban column",
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
        description: "Delete a kanban column",
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
        description: "Reorder kanban columns",
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
        description: "List kanban by business",
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
        description: "Create a new kanban card",
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
        description: "Update a kanban card",
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
        description: "Delete a kanban card",
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
        description: "Reorder kanban cards",
      },
    },
    reorderKanbanCardsController.handle,
  );
}

export { kanbanRoutes };
