import { FastifyInstance } from "fastify";

import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { ListVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/list-vehicle-checklist-controller";

import { ListVehicleChecklistBusinessController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist-business/list-vehicle-checklist-business-controller";

import { DeleteVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-controller";
import { UpdateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-controller";

import { ExportVehicleChecklistExcelController } from "@/modules/vehicle-checklist/usecases/export-vehicle-checklist-excel/export-vehicle-checklist-excel-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleChecklistSchemas,
  vehicleChecklistResponses,
} from "./documentation/vehicle-checklist-documentation";

const createVehicleChecklistController = new CreateVehicleChecklistController();
const listVehicleChecklistController = new ListVehicleChecklistController();

const listVehicleChecklistBusinessController =
  new ListVehicleChecklistBusinessController();

const deleteVehicleChecklistController = new DeleteVehicleChecklistController();
const updateVehicleChecklistController = new UpdateVehicleChecklistController();

const exportVehicleChecklistExcelController =
  new ExportVehicleChecklistExcelController();

async function vehicleChecklistRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle-checklist/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Create a new vehicle checklist",
        description:
          "Register a new vehicle inspection checklist with vehicle, driver, and checklist details. Supports multipart/form-data for photos. Photos are categorized by field and some are mandatory based on checklist values.",
        consumes: ["multipart/form-data"],
        params: vehicleChecklistSchemas.businessIdParam,
        response: {
          201: vehicleChecklistResponses.vehicleChecklistCreated,
          400: vehicleChecklistResponses.createVehicleChecklistErrors,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    createVehicleChecklistController.handle,
  );

  app.get(
    "/list-vehicle-checklist",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "List vehicle checklists",
        description:
          "Retrieve a paginated list of vehicle checklists with optional search filters",
        querystring: vehicleChecklistSchemas.listVehicleChecklist,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistList,
          400: vehicleChecklistResponses.listVehicleChecklistErrors,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    listVehicleChecklistController.handle,
  );

  app.get(
    "/list-vehicle-checklist-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "List vehicle checklists by business",
        description:
          "Retrieve a paginated list of vehicle checklists filtered by business",
        querystring: vehicleChecklistSchemas.listVehicleChecklistBusiness,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistList,
          400: vehicleChecklistResponses.listVehicleChecklistBusinessErrors,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    listVehicleChecklistBusinessController.handle,
  );

  app.patch(
    "/update-vehicle-checklist/:checklistId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Update a vehicle checklist",
        description:
          "Update an existing vehicle inspection checklist with vehicle, driver, and checklist details. Supports multipart/form-data for photos. All fields are optional. Can add new photos or remove existing ones.",
        consumes: ["multipart/form-data"],
        params: vehicleChecklistSchemas.updateDeleteVehicleChecklist,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistUpdated,
          400: vehicleChecklistResponses.updateVehicleChecklistErrors,
          404: vehicleChecklistResponses.vehicleChecklistNotFound,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    updateVehicleChecklistController.handle,
  );

  app.delete(
    "/delete-vehicle-checklist/:checklistId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Delete a vehicle checklist",
        description:
          "Permanently delete a vehicle checklist record from the system",
        params: vehicleChecklistSchemas.updateDeleteVehicleChecklist,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistDeleted,
          400: vehicleChecklistResponses.resourceNotFound,
          403: vehicleChecklistResponses.vehicleChecklistNotBelongBusiness,
          404: vehicleChecklistResponses.vehicleChecklistNotFound,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    deleteVehicleChecklistController.handle,
  );

  app.get(
    "/export-vehicle-checklist-excel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Export vehicle checklists to Excel",
        description:
          "Export all vehicle inspection checklists to an Excel file with optional search filters",
        querystring: vehicleChecklistSchemas.exportVehicleChecklistsQuery,
        produces: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
      },
    },
    exportVehicleChecklistExcelController.handle,
  );
}

export { vehicleChecklistRoutes };
