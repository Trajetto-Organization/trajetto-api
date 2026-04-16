import { FastifyInstance } from "fastify";

import { CreateFineController } from "@/modules/fine/usecases/create-fine/create-fine-controller";
import { ListFineController } from "@/modules/fine/usecases/list-fine/list-fine-controller";

import { ExportFineController } from "@/modules/fine/usecases/export-fine/export-fine-controller";

import { UpdateFineController } from "@/modules/fine/usecases/update-fine/update-fine-controller";
import { DeleteFineController } from "@/modules/fine/usecases/delete-fine/delete-fine-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import { fineSchemas, fineResponses } from "./documentation/fine-documentation";

const createFineController = new CreateFineController();
const listFineController = new ListFineController();

const exportFineController = new ExportFineController();

const updateFineController = new UpdateFineController();
const deleteFineController = new DeleteFineController();

async function fineRoutes(app: FastifyInstance) {
  app.post(
    "/create-fine/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("fine_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Create a new fine",
        description:
          "Register a new traffic violation fine for a driver and vehicle",
        params: fineSchemas.updateDeleteBusiness,
        body: fineSchemas.createFine,
        response: {
          201: fineResponses.fineCreated,
          400: fineResponses.createFineErrors,
          403: fineResponses.createFineForbiddenErrors,
          500: fineResponses.internalServerError,
        },
      },
    },
    createFineController.handle,
  );

  app.get(
    "/list-fine",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "List fines",
        description:
          "Retrieve a paginated list of traffic violation fines with optional search filters",
        querystring: fineSchemas.listFines,
        response: {
          200: fineResponses.finesList,
          400: fineResponses.resourceNotFound,
          500: fineResponses.internalServerError,
        },
      },
    },
    listFineController.handle,
  );

  app.get(
    "/export-fine",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Export fine records (CSV or Excel)",
        description:
          "Export fine records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: fineSchemas.exportFinesQuery,
        response: {
          400: fineResponses.exportFineErrors,
          500: fineResponses.internalServerError,
        },
      },
    },
    exportFineController.handle,
  );

  app.patch(
    "/update-fine/:fineId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("fine_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Update a fine",
        description:
          "Update information about an existing traffic violation fine",
        params: fineSchemas.fineBusinessParams,
        body: fineSchemas.updateFine,
        response: {
          200: fineResponses.fineUpdated,
          400: fineResponses.updateFineErrors,
          403: fineResponses.updateFineForbiddenErrors,
          404: fineResponses.fineNotFound,
          500: fineResponses.internalServerError,
        },
      },
    },
    updateFineController.handle,
  );

  app.delete(
    "/delete-fine/:fineId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Delete a fine",
        description: "Permanently delete a traffic violation fine record",
        params: fineSchemas.updateDeleteFine,
        response: {
          200: fineResponses.fineDeleted,
          400: fineResponses.resourceNotFound,
          404: fineResponses.fineNotFound,
          500: fineResponses.internalServerError,
        },
      },
    },
    deleteFineController.handle,
  );
}

export { fineRoutes };
