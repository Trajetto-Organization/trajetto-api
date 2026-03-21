import { FastifyInstance } from "fastify";

import { CreateBusinessController } from "@/modules/business/usecases/create-business/create-business-controller";
import { ListBusinessController } from "@/modules/business/usecases/list-business/list-business-controller";

import { SearchBusinessCursorController } from "@/modules/business/usecases/search-business-cursor/search-business-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { DeleteBusinessController } from "@/modules/business/usecases/delete-business/delete-business-controller";

import { UpdateBusinessController } from "@/modules/business/usecases/update-business/update-business-controller";
import { UpdateAILimitController } from "@/modules/business/usecases/update-ai-limit/update-ai-limit-controller";

import { GetAIUsageController } from "@/modules/business/usecases/get-ai-usage/get-ai-usage-controller";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import {
  businessResponses,
  businessSchemas,
} from "./documentation/business-documentation";

const createBusinessController = new CreateBusinessController();
const listBusinessController = new ListBusinessController();

const searchBusinessCursorController = new SearchBusinessCursorController();

const deleteBusinessController = new DeleteBusinessController();
const updateBusinessController = new UpdateBusinessController();

const updateAILimitController = new UpdateAILimitController();
const getAIUsageController = new GetAIUsageController();

async function businessRoutes(app: FastifyInstance) {
  app.post(
    "/create-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Create a new business",
        description:
          "Register a new business entity in the fleet management system with company information and administrative details",
        body: businessSchemas.createBusiness,
        response: {
          201: businessResponses.businessCreated,
          400: businessResponses.createBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    createBusinessController.handle,
  );

  app.get(
    "/list-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "List businesses",
        description:
          "Retrieve a paginated list of business entities with optional search and filtering capabilities",
        querystring: businessSchemas.listBusiness,
        response: {
          200: businessResponses.businessList,
          400: businessResponses.listBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    listBusinessController.handle,
  );

  app.get(
    "/search-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Search businesses (cursor-based)",
        description:
          "Retrieve businesses as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual business objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: businessSchemas.searchBusinessCursor,
        response: {
          200: businessResponses.searchBusinessStreamDescription,
          400: businessResponses.listBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    searchBusinessCursorController.handle,
  );

  app.patch(
    "/update-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Update a business",
        description:
          "Update existing business information including company details, contact information, and administrative settings",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateBusiness,
        response: {
          200: businessResponses.businessUpdated,
          400: businessResponses.updateBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateBusinessController.handle,
  );

  app.patch(
    "/update-ai-limit/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Update AI analysis limit for a business",
        description:
          "Set the monthly AI analysis limit for a specific business entity. A limit of 0 disables AI analysis for the company.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateAILimit,
        response: {
          200: businessResponses.aiLimitUpdated,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateAILimitController.handle,
  );

  app.get(
    "/get-ai-usage/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Get AI analysis usage for a business",
        description:
          "Retrieve current AI analysis usage, limits, and remaining quota for a business",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.aiUsageData,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    getAIUsageController.handle,
  );

  app.delete(
    "/delete-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Delete a business",
        description:
          "Permanently remove a business entity and all associated data from the fleet management system",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.businessDeleted,
          400: businessResponses.deleteBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    deleteBusinessController.handle,
  );
}

export { businessRoutes };
