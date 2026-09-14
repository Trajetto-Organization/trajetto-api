import { FastifyInstance } from "fastify";

import { CreateBusinessController } from "@/modules/business/usecases/create-business/create-business-controller";
import { ListBusinessController } from "@/modules/business/usecases/list-business/list-business-controller";

import { SearchBusinessCursorController } from "@/modules/business/usecases/search-business-cursor/search-business-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { DeleteBusinessController } from "@/modules/business/usecases/delete-business/delete-business-controller";

import { UpdateBusinessController } from "@/modules/business/usecases/update-business/update-business-controller";
import { ToggleBusinessActiveController } from "@/modules/business/usecases/toggle-business-active/toggle-business-active-controller";

import { RequestBusinessDeletionController } from "@/modules/business/usecases/request-business-deletion/request-business-deletion-controller";
import { UpdateAILimitController } from "@/modules/business/usecases/update-ai-limit/update-ai-limit-controller";
import { UpdateVehicleLimitController } from "@/modules/business/usecases/update-vehicle-limit/update-vehicle-limit-controller";
import {
  GetBusinessEntitlementsController,
  GetModuleImpactController,
  UpdateBusinessEntitlementController,
} from "@/modules/business/usecases/manage-entitlements/manage-entitlements-controller";

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
const requestBusinessDeletionController =
  new RequestBusinessDeletionController();

const updateBusinessController = new UpdateBusinessController();
const toggleBusinessActiveController = new ToggleBusinessActiveController();

const updateAILimitController = new UpdateAILimitController();
const updateVehicleLimitController = new UpdateVehicleLimitController();

const getBusinessEntitlementsController =
  new GetBusinessEntitlementsController();
const updateBusinessEntitlementController =
  new UpdateBusinessEntitlementController();
const getModuleImpactController = new GetModuleImpactController();
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

  app.patch(
    "/update-vehicle-limit/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Update the contracted vehicle limit for a business",
        description:
          "Set the contracted fleet size (billing baseline). 0 = not configured, never blocks. Lowering below the current fleet keeps existing vehicles and only blocks new registrations.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateVehicleLimit,
        response: {
          200: businessResponses.vehicleLimitUpdated,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateVehicleLimitController.handle,
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

  app.get(
    "/entitlements/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Get the company's plan: hired modules and fleet usage",
        description:
          "Hired modules (FLEET, DELIVERIES) plus the contracted vehicle limit and how many vehicles are registered. Business admins read their own company; MASTER reads any.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.entitlementsData,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    getBusinessEntitlementsController.handle,
  );

  app.get(
    "/entitlements/:businessId/impact/:module",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "What a company has riding on a module",
        description:
          "Record counts, work in flight and how many users lose menu items if the module is switched off. Feeds the confirmation dialog — nothing here is deleted by disabling.",
        params: businessSchemas.moduleImpactParams,
        response: {
          200: businessResponses.moduleImpactData,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    getModuleImpactController.handle,
  );

  app.put(
    "/entitlements/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Enable or disable a module for a company",
        description:
          "Flips a sellable module (FLEET, DELIVERIES) on or off for the company. Module-gated routes reject companies without the module enabled.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateEntitlement,
        response: {
          200: businessResponses.entitlementUpdated,
          400: businessResponses.aiLimitErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateBusinessEntitlementController.handle,
  );

  app.post(
    "/request-business-deletion/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Request business deletion (sends confirmation code)",
        description:
          "First step of the two-step business deletion flow. Validates that the business can be deleted (no branches, users or drivers linked) and sends a 6-digit confirmation code to the requesting MASTER user's email. The code expires in 5 minutes. Use the DELETE endpoint with the code to actually delete the business.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.businessDeletionCodeSent,
          400: businessResponses.requestBusinessDeletionErrors,
          404: businessResponses.businessNotFound,
          409: businessResponses.businessHasChildrenConflict,
          500: businessResponses.internalServerError,
        },
      },
    },
    requestBusinessDeletionController.handle,
  );

  app.delete(
    "/delete-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Confirm business deletion (with confirmation code)",
        description:
          "Second step of the two-step business deletion flow. Validates the 6-digit confirmation code received by email, then permanently removes the business. After deletion, all other MASTER users (excluding the deleter) receive an audit notification by email.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.confirmDeletionCode,
        response: {
          200: businessResponses.businessDeleted,
          400: businessResponses.confirmBusinessDeletionErrors,
          404: businessResponses.businessNotFound,
          409: businessResponses.businessHasChildrenConflict,
          500: businessResponses.internalServerError,
        },
      },
    },
    deleteBusinessController.handle,
  );

  app.patch(
    "/toggle-business-active/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Toggle business active status",
        description:
          "Activate or deactivate a business. Inactive businesses block login for all associated users.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.businessToggled,
          400: businessResponses.deleteBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    toggleBusinessActiveController.handle,
  );
}

export { businessRoutes };
