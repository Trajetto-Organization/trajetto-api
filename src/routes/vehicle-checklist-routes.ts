import { FastifyInstance } from "fastify";

import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { ListVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/list-vehicle-checklist-controller";

import { DeleteVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-controller";
import { UpdateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-controller";

import { ExportVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/export-vehicle-checklist-excel/export-vehicle-checklist-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleChecklistSchemas,
  vehicleChecklistResponses,
} from "./documentation/vehicle-checklist-documentation";

const createVehicleChecklistController = new CreateVehicleChecklistController();
const listVehicleChecklistController = new ListVehicleChecklistController();

const deleteVehicleChecklistController = new DeleteVehicleChecklistController();
const updateVehicleChecklistController = new UpdateVehicleChecklistController();

const exportVehicleChecklistController = new ExportVehicleChecklistController();

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
    "/export-vehicle-checklist",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Export vehicle checklist records (CSV or Excel)",
        description:
          "Export vehicle checklist records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: vehicleChecklistSchemas.exportVehicleChecklistsQuery,
      },
    },
    exportVehicleChecklistController.handle,
  );
}

export { vehicleChecklistRoutes };
