import { FastifyInstance } from "fastify";

import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { ListVehicleChecklistBusinessController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist-business/list-vehicle-checklist-business-controller";

import { DeleteVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

const createVehicleChecklistController = new CreateVehicleChecklistController();
const listVehicleChecklistBusinessController =
  new ListVehicleChecklistBusinessController();

const deleteVehicleChecklistController = new DeleteVehicleChecklistController();

async function vehicleChecklistRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle-checklist/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Create a new vehicle checklist",
        description:
          "Register a new vehicle inspection checklist with vehicle, driver, and checklist details. Supports multipart/form-data for optional photos.",
        consumes: ["multipart/form-data"],
      },
    },
    createVehicleChecklistController.handle,
  );

  app.get(
    "/list-vehicle-checklist-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "List vehicle checklists by business",
        description:
          "Retrieve a paginated list of vehicle checklists filtered by business with optional search and filters",
      },
    },
    listVehicleChecklistBusinessController.handle,
  );

  app.delete(
    "/delete-vehicle-checklist/:checklistId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Delete a vehicle checklist",
        description:
          "Permanently delete a vehicle checklist record from the system",
      },
    },
    deleteVehicleChecklistController.handle,
  );
}

export { vehicleChecklistRoutes };
