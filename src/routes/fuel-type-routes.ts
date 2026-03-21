import { FastifyInstance } from "fastify";

import { CreateFuelTypeController } from "@/modules/fuel-type/usecases/create-fuel-type/create-fuel-type-controller";
import { ListFuelTypeController } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-controller";

import { UpdateFuelTypeController } from "@/modules/fuel-type/usecases/update-fuel-type/update-fuel-type-controller";
import { DeleteFuelTypeController } from "@/modules/fuel-type/usecases/delete-fuel-type/delete-fuel-type-controller";

import { SearchFuelTypeCursorController } from "@/modules/fuel-type/usecases/search-fuel-type-cursor/search-fuel-type-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  fuelTypeSchemas,
  fuelTypeResponses,
} from "./documentation/fuel-type-documentation";

const createFuelTypeController = new CreateFuelTypeController();
const listFuelTypeController = new ListFuelTypeController();

const searchFuelTypeCursorController = new SearchFuelTypeCursorController();

const updateFuelTypeController = new UpdateFuelTypeController();
const deleteFuelTypeController = new DeleteFuelTypeController();

async function fuelTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-fuel-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuelType"],
        summary: "Create a new fuel type",
        description:
          "Register a new fuel type category (gasoline, diesel, ethanol, etc.) with pricing information and business association",
        params: fuelTypeSchemas.businessIdParam,
        body: fuelTypeSchemas.createFuelType,
        response: {
          201: fuelTypeResponses.fuelTypeCreated,
          400: fuelTypeResponses.createFuelTypeErrors,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    createFuelTypeController.handle,
  );

  app.get(
    "/list-fuel-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuelType"],
        summary: "List fuel types",
        description:
          "Retrieve a paginated list of available fuel type categories with their descriptions and pricing information",
        querystring: fuelTypeSchemas.listFuelType,
        response: {
          200: fuelTypeResponses.fuelTypeList,
          400: fuelTypeResponses.listFuelTypeErrors,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    listFuelTypeController.handle,
  );

  app.get(
    "/search-fuel-type-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuelType"],
        summary: "Search fuel types by business (cursor-based)",
        description:
          "Retrieve fuel types as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual fuel type objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: fuelTypeSchemas.searchFuelTypeCursor,
        response: {
          200: fuelTypeResponses.searchFuelTypeStreamDescription,
          400: fuelTypeResponses.listFuelTypeBusinessErrors,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    searchFuelTypeCursorController.handle,
  );

  app.patch(
    "/update-fuel-type/:fuelTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuelType"],
        summary: "Update a fuel type",
        description:
          "Update existing fuel type information including description, pricing details, and category specifications",
        params: fuelTypeSchemas.fuelTypeBusinessParams,
        body: fuelTypeSchemas.updateFuelType,
        response: {
          200: fuelTypeResponses.fuelTypeUpdated,
          400: fuelTypeResponses.updateFuelTypeErrors,
          403: fuelTypeResponses.updateFuelTypeForbiddenErrors,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    updateFuelTypeController.handle,
  );

  app.delete(
    "/delete-fuel-type/:fuelTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuelType"],
        summary: "Delete a fuel type",
        description:
          "Permanently remove a fuel type category from the system and all associated refueling records",
        params: fuelTypeSchemas.fuelTypeBusinessParams,
        response: {
          200: fuelTypeResponses.fuelTypeDeleted,
          400: fuelTypeResponses.deleteFuelTypeErrors,
          403: fuelTypeResponses.deleteFuelTypeForbiddenErrors,
          500: fuelTypeResponses.internalServerError,
        },
      },
    },
    deleteFuelTypeController.handle,
  );
}

export { fuelTypeRoutes };
