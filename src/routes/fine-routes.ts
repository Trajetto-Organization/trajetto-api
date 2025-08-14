import { FastifyInstance } from "fastify";
import { z } from "zod";

import { CreateFineController } from "@/modules/fine/usecases/create-fine/create-fine-controller";
import { ListFineController } from "@/modules/fine/usecases/list-fine/list-fine-controller";

import { ExportFineExcelController } from "@/modules/fine/usecases/export-fine-excel/export-fine-excel-controller";

import { UpdateFineController } from "@/modules/fine/usecases/update-fine/update-fine-controller";
import { DeleteFineController } from "@/modules/fine/usecases/delete-fine/delete-fine-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { fineSchemas, fineResponses } from "./documentation/fine-documentation";

const createFineController = new CreateFineController();
const listFineController = new ListFineController();

const exportFineExcelController = new ExportFineExcelController();

const updateFineController = new UpdateFineController();
const deleteFineController = new DeleteFineController();

async function fineRoutes(app: FastifyInstance) {
  app.post(
    "/create-fine/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Create a new fine",
        description: "Register a new traffic violation fine for a driver and vehicle",
        params: fineSchemas.updateDeleteBusiness,
        body: fineSchemas.createFine,
        response: {
          201: fineResponses.fineCreated,
          400: z.union([
            fineResponses.resourceNotFound,
            fineResponses.businessNotFound,
            fineResponses.branchNotFound,
            fineResponses.driverNotFound,
            fineResponses.vehicleNotFound,
            fineResponses.trafficViolationCodeNotFound,
            fineResponses.fineNumberAlreadyExists,
            fineResponses.validationError,
          ]),
          403: z.union([
            fineResponses.branchNotBelongBusiness,
            fineResponses.driverNotBelongBusiness,
            fineResponses.vehicleNotBelongBusiness,
          ]),
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
        description: "Retrieve a paginated list of traffic violation fines with optional search filters",
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
    "/export-fine-excel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Export fines to Excel",
        description: "Export a comprehensive fines report to Excel format with optional search filters",
        querystring: fineSchemas.exportFinesQuery,
        produces: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      },
    },
    exportFineExcelController.handle,
  );

  app.patch(
    "/update-fine/:fineId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Update a fine",
        description: "Update information about an existing traffic violation fine",
        params: fineSchemas.updateDeleteFine,
        body: fineSchemas.updateFine,
        response: {
          200: fineResponses.fineUpdated,
          400: z.union([
            fineResponses.resourceNotFound,
            fineResponses.branchNotFound,
            fineResponses.driverNotFound,
            fineResponses.vehicleNotFound,
            fineResponses.trafficViolationCodeNotFound,
            fineResponses.fineNumberAlreadyExists,
            fineResponses.validationError,
          ]),
          403: z.union([
            fineResponses.branchNotBelongBusiness,
            fineResponses.driverNotBelongBusiness,
            fineResponses.vehicleNotBelongBusiness,
          ]),
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
          500: fineResponses.internalServerError,
        },
      },
    },
    deleteFineController.handle,
  );
}

export { fineRoutes };
