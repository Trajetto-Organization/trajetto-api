import { FastifyInstance } from "fastify";

import { CreateDriverController } from "@/modules/driver/usecases/create-driver/create-driver-controller";
import { ListDriverController } from "@/modules/driver/usecases/list-driver/list-driver-controller";

import { UpdateDriverController } from "@/modules/driver/usecases/update-driver/update-driver-controller";
import { DeleteDriverController } from "@/modules/driver/usecases/delete-driver/delete-driver-controller";

import { ExportDriverController } from "@/modules/driver/usecases/export-driver/export-driver-controller";
import { SearchDriverCursorController } from "@/modules/driver/usecases/search-driver-cursor/search-driver-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  driverSchemas,
  driverResponses,
} from "./documentation/driver-documentation";

const createDriverController = new CreateDriverController();
const listDriverController = new ListDriverController();

const exportDriverController = new ExportDriverController();
const searchDriverCursorController = new SearchDriverCursorController();

const updateDriverController = new UpdateDriverController();
const deleteDriverController = new DeleteDriverController();

async function driverRoutes(app: FastifyInstance) {
  app.post(
    "/create-driver/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Create a new driver",
        description:
          "Register a new driver in the fleet management system with personal information, license details, and business association",
        params: driverSchemas.businessIdParam,
        body: driverSchemas.createDriver,
        response: {
          201: driverResponses.driverCreated,
          400: driverResponses.createDriverErrors,
          403: driverResponses.createDriverForbiddenErrors,
          500: driverResponses.internalServerError,
        },
      },
    },
    createDriverController.handle,
  );

  app.get(
    "/list-driver",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "List drivers",
        description:
          "Retrieve a paginated list of drivers with optional search functionality and filtering capabilities",
        querystring: driverSchemas.listDriver,
        response: {
          200: driverResponses.driverList,
          400: driverResponses.listDriverErrors,
          500: driverResponses.internalServerError,
        },
      },
    },
    listDriverController.handle,
  );

  app.get(
    "/export-driver",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Export driver records (CSV or Excel)",
        description:
          "Export driver records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: driverSchemas.exportDriverQuery,
      },
    },
    exportDriverController.handle,
  );

  app.get(
    "/search-driver-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Search drivers by business (cursor-based)",
        description:
          "Retrieve drivers as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual driver objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: driverSchemas.searchDriverCursor,
        response: {
          200: driverResponses.searchDriverStreamDescription,
          400: driverResponses.listDriverBusinessErrors,
          500: driverResponses.internalServerError,
        },
      },
    },
    searchDriverCursorController.handle,
  );

  app.patch(
    "/update-driver/:driverId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Update a driver",
        description:
          "Update existing driver information including personal details, contact information, and license data",
        params: driverSchemas.driverBusinessParams,
        body: driverSchemas.updateDriver,
        response: {
          200: driverResponses.driverUpdated,
          400: driverResponses.updateDriverErrors,
          403: driverResponses.updateDriverForbiddenErrors,
          500: driverResponses.internalServerError,
        },
      },
    },
    updateDriverController.handle,
  );

  app.delete(
    "/delete-driver/:driverId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("driver_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver"],
        summary: "Delete a driver",
        description:
          "Permanently remove a driver record from the fleet management system",
        params: driverSchemas.driverBusinessParams,
        response: {
          200: driverResponses.driverDeleted,
          400: driverResponses.deleteDriverErrors,
          403: driverResponses.deleteDriverForbiddenErrors,
          500: driverResponses.internalServerError,
        },
      },
    },
    deleteDriverController.handle,
  );
}

export { driverRoutes };
