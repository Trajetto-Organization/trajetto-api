import { FastifyInstance } from "fastify";

import { CreateVehicleController } from "@/modules/vehicle/usecases/create-vehicle/create-vehicle-controller";
import { ListVehicleController } from "@/modules/vehicle/usecases/list-vehicle/list-vehicle-controller";

import { UpdateVehicleController } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-controller";
import { DeleteVehicleController } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-controller";

import { ExportVehicleController } from "@/modules/vehicle/usecases/export-vehicle/export-vehicle-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleSchemas,
  vehicleResponses,
} from "./documentation/vehicle-documentation";

import { GetVehicleController } from "@/modules/vehicle/usecases/get-vehicle/get-vehicle-controller";
import { SearchVehicleCursorController } from "@/modules/vehicle/usecases/search-vehicle-cursor/search-vehicle-cursor-controller";

const createVehicleController = new CreateVehicleController();
const listVehicleController = new ListVehicleController();

const exportVehicleController = new ExportVehicleController();

const getVehicleController = new GetVehicleController();
const searchVehicleCursorController = new SearchVehicleCursorController();

const updateVehicleController = new UpdateVehicleController();
const deleteVehicleController = new DeleteVehicleController();

async function vehicleRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Create a new vehicle",
        description:
          "Register a new vehicle in the fleet management system with specifications and operational details",
        params: vehicleSchemas.businessIdParam,
        body: vehicleSchemas.createVehicle,
        response: {
          201: vehicleResponses.vehicleCreated,
          400: vehicleResponses.createVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    createVehicleController.handle,
  );

  app.get(
    "/list-vehicle",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "List vehicles",
        description:
          "Retrieve a paginated list of fleet vehicles with optional search and filtering capabilities",
        querystring: vehicleSchemas.listVehicle,
        response: {
          200: vehicleResponses.vehicleList,
          400: vehicleResponses.listVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    listVehicleController.handle,
  );

  app.get(
    "/export-vehicle",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Export vehicle records (CSV or Excel)",
        description:
          "Export vehicle records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: vehicleSchemas.exportVehicleQuery,
      },
    },
    exportVehicleController.handle,
  );

  app.get(
    "/search-vehicle-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Search vehicles by business (cursor-based)",
        description:
          "Retrieve vehicles as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual vehicle objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: vehicleSchemas.searchVehicleCursor,
        response: {
          200: vehicleResponses.searchVehicleStreamDescription,
          400: vehicleResponses.listVehicleBusinessErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    searchVehicleCursorController.handle,
  );

  app.get(
    "/get-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Get a vehicle",
        description:
          "Retrieve detailed information about a specific vehicle by its ID and business ID",
        params: vehicleSchemas.getVehicle,
        response: {
          200: vehicleResponses.vehicleReturned,
          400: vehicleResponses.getVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    getVehicleController.handle,
  );

  app.patch(
    "/update-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Update a vehicle",
        description:
          "Update existing vehicle information including specifications, maintenance data, and operational status",
        params: vehicleSchemas.vehicleBusinessParams,
        body: vehicleSchemas.updateVehicle,
        response: {
          200: vehicleResponses.vehicleUpdated,
          400: vehicleResponses.updateVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    updateVehicleController.handle,
  );

  app.delete(
    "/delete-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        summary: "Delete a vehicle",
        description:
          "Permanently remove a vehicle from the fleet management system and all associated records",
        params: vehicleSchemas.vehicleBusinessParams,
        response: {
          200: vehicleResponses.vehicleDeleted,
          400: vehicleResponses.deleteVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    deleteVehicleController.handle,
  );
}

export { vehicleRoutes };
