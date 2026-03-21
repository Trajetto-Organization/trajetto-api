import { FastifyInstance } from "fastify";

import { CreateFuelController } from "@/modules/fuel/usecases/create-fuel/create-fuel-controller";
import { ListFuelController } from "@/modules/fuel/usecases/list-fuel/list-fuel-controller";

import { UpdateFuelController } from "@/modules/fuel/usecases/update-fuel/update-fuel-controller";

import { DeleteFuelController } from "@/modules/fuel/usecases/delete-fuel/delete-fuel-controller";
import { ExportFuelController } from "@/modules/fuel/usecases/export-fuel/export-fuel-controller";

import { GetPreviousFuelController } from "@/modules/fuel/usecases/get-previous-fuel/get-previous-fuel-controller";
import { SearchFuelByVehicleCursorController } from "@/modules/fuel/usecases/search-fuel-by-vehicle-cursor/search-fuel-by-vehicle-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { fuelSchemas, fuelResponses } from "./documentation/fuel-documentation";

const createFuelController = new CreateFuelController();
const listFuelController = new ListFuelController();

const updateFuelController = new UpdateFuelController();

const deleteFuelController = new DeleteFuelController();
const exportFuelController = new ExportFuelController();

const getPreviousFuelController = new GetPreviousFuelController();
const searchFuelByVehicleCursorController =
  new SearchFuelByVehicleCursorController();

async function fuelRoutes(app: FastifyInstance) {
  app.post(
    "/create-fuel/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Create a new fuel record",
        description:
          "Register a new fuel refueling record for a vehicle with driver, mileage, and fuel details. Requires multipart/form-data with odometer photo.",
        params: fuelSchemas.updateDeleteBusiness,
        consumes: ["multipart/form-data"],
        response: {
          201: fuelResponses.fuelCreated,
          400: fuelResponses.createFuelErrors,
          500: fuelResponses.internalServerError,
        },
      },
    },
    createFuelController.handle,
  );

  app.get(
    "/list-fuel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "List fuel records",
        description:
          "Retrieve a paginated list of fuel refueling records with optional search filters",
        querystring: fuelSchemas.listFuel,
        response: {
          200: fuelResponses.fuelList,
          400: fuelResponses.listFuelErrors,
          500: fuelResponses.internalServerError,
        },
      },
    },
    listFuelController.handle,
  );

  app.patch(
    "/update-fuel/:fuelId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Update a fuel record",
        description:
          "Update information about an existing fuel refueling record including mileage, fuel details, and related entities. Supports multipart/form-data for optional odometer photo update.",
        params: fuelSchemas.updateDeleteFuel,
        consumes: ["multipart/form-data"],
        response: {
          200: fuelResponses.fuelUpdated,
          400: fuelResponses.updateFuelErrors,
          500: fuelResponses.internalServerError,
        },
      },
    },
    updateFuelController.handle,
  );

  app.delete(
    "/delete-fuel/:fuelId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Delete a fuel record",
        description:
          "Permanently delete a fuel refueling record from the system",
        params: fuelSchemas.updateDeleteFuel,
        response: {
          200: fuelResponses.fuelDeleted,
          400: fuelResponses.driverCannotDeleteFuel,
          403: fuelResponses.fuelNotBelongBusiness,
          404: fuelResponses.deleteFuelNotFoundErrors,
          500: fuelResponses.internalServerError,
        },
      },
    },
    deleteFuelController.handle,
  );

  app.get(
    "/export-fuel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Export fuel records (CSV or Excel)",
        description:
          "Export fuel refueling records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: fuelSchemas.exportFuelsQuery,
      },
    },
    exportFuelController.handle,
  );

  app.get(
    "/get-previous-fuel/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Get previous fuel record for a vehicle",
        description:
          "Retrieve the previous fuel refueling record for a specific vehicle before a given date",
        params: fuelSchemas.getPreviousFuelParams,
        querystring: fuelSchemas.getPreviousFuelQuery,
        response: {
          200: fuelResponses.fuelReturned,
          400: fuelResponses.getPreviousFuelErrors,
          404: fuelResponses.getPreviousFuelNotFound,
          500: fuelResponses.internalServerError,
        },
      },
    },
    getPreviousFuelController.handle,
  );

  app.get(
    "/search-fuel-by-vehicle/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Search fuel records by vehicle (cursor-based)",
        description:
          "Retrieve fuel records for a specific vehicle as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual fuel objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        params: fuelSchemas.searchFuelByVehicleParams,
        querystring: fuelSchemas.searchFuelByVehicleCursor,
        response: {
          200: fuelResponses.searchFuelByVehicleStreamDescription,
          400: fuelResponses.listFuelByVehicleErrors,
          403: fuelResponses.vehicleNotBelongBusiness,
          500: fuelResponses.internalServerError,
        },
      },
    },
    searchFuelByVehicleCursorController.handle,
  );
}

export { fuelRoutes };
