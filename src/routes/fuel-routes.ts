import { FastifyInstance } from "fastify";

import { CreateFuelController } from "@/modules/fuel/usecases/create-fuel/create-fuel-controller";
import { ListFuelController } from "@/modules/fuel/usecases/list-fuel/list-fuel-controller";

import { ListFuelBusinessController } from "@/modules/fuel/usecases/list-fuel-business/list-fuel-business-controller";
import { ListFuelByVehicleController } from "@/modules/fuel/usecases/list-fuel-by-vehicle/list-fuel-by-vehicle-controller";

import { UpdateFuelController } from "@/modules/fuel/usecases/update-fuel/update-fuel-controller";

import { DeleteFuelController } from "@/modules/fuel/usecases/delete-fuel/delete-fuel-controller";
import { ExportFuelExcelController } from "@/modules/fuel/usecases/export-fuel-excel/export-fuel-excel-controller";

import { GetPreviousFuelController } from "@/modules/fuel/usecases/get-previous-fuel/get-previous-fuel-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { fuelSchemas, fuelResponses } from "./documentation/fuel-documentation";

const createFuelController = new CreateFuelController();
const listFuelController = new ListFuelController();

const listFuelBusinessController = new ListFuelBusinessController();
const listFuelByVehicleController = new ListFuelByVehicleController();

const updateFuelController = new UpdateFuelController();

const deleteFuelController = new DeleteFuelController();
const exportFuelExcelController = new ExportFuelExcelController();

const getPreviousFuelController = new GetPreviousFuelController();

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

  app.get(
    "/list-fuel-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "List fuel records by business",
        description:
          "Retrieve a paginated list of fuel refueling records filtered by business with optional search",
        querystring: fuelSchemas.listFuelBusiness,
        response: {
          200: fuelResponses.fuelList,
          400: fuelResponses.listFuelBusinessErrors,
          500: fuelResponses.internalServerError,
        },
      },
    },
    listFuelBusinessController.handle,
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
    "/export-fuel-excel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Export fuel records to Excel",
        description:
          "Export all fuel refueling records to an Excel file with optional search filters",
        querystring: fuelSchemas.exportFuelsQuery,
        produces: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
      },
    },
    exportFuelExcelController.handle,
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
    "/list-fuel-by-vehicle/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "List fuel records by vehicle",
        description:
          "Retrieve a paginated list of fuel refueling records for a specific vehicle",
        params: fuelSchemas.listFuelByVehicleParams,
        querystring: fuelSchemas.listFuelByVehicleQuery,
        response: {
          200: fuelResponses.fuelList,
          400: fuelResponses.listFuelByVehicleErrors,
          403: fuelResponses.vehicleNotBelongBusiness,
          500: fuelResponses.internalServerError,
        },
      },
    },
    listFuelByVehicleController.handle,
  );
}

export { fuelRoutes };
