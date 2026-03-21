import { FastifyInstance } from "fastify";

import { CreateBranchController } from "@/modules/branch/usecases/create-branch/create-branch-controller";
import { DeleteBranchController } from "@/modules/branch/usecases/delete-branch/delete-branch-controller";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ListBranchController } from "@/modules/branch/usecases/list-branch/list-branch-controller";
import { UpdateBranchController } from "@/modules/branch/usecases/update-branch/update-branch-controller";

import { SearchBranchCursorController } from "@/modules/branch/usecases/search-branch-cursor/search-branch-cursor-controller";
import {
  branchResponses,
  branchSchemas,
} from "./documentation/branch-documentation";

const createBranchController = new CreateBranchController();
const deleteBranchController = new DeleteBranchController();

const updateBranchController = new UpdateBranchController();
const listBranchController = new ListBranchController();

const searchBranchCursorController = new SearchBranchCursorController();

async function branchRoutes(app: FastifyInstance) {
  app.post(
    "/create-branch/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Create a new branch",
        description:
          "Register a new business branch location with address, contact information, and operational details",
        params: branchSchemas.businessIdParam,
        body: branchSchemas.createBranch,
        response: {
          201: branchResponses.branchCreated,
          400: branchResponses.createBranchErrors,
          500: branchResponses.internalServerError,
        },
      },
    },
    createBranchController.handle,
  );

  app.get(
    "/list-branch",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "List branches",
        description:
          "Retrieve a paginated list of business branch locations with optional search and filtering capabilities",
        querystring: branchSchemas.listBranch,
        response: {
          200: branchResponses.branchList,
          400: branchResponses.listBranchErrors,
          500: branchResponses.internalServerError,
        },
      },
    },
    listBranchController.handle,
  );

  app.get(
    "/search-branch-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Search branches by business (cursor-based)",
        description:
          "Retrieve branches as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual branch objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: branchSchemas.searchBranchCursor,
        response: {
          200: branchResponses.searchBranchStreamDescription,
          400: branchResponses.listBranchBusinessErrors,
          500: branchResponses.internalServerError,
        },
      },
    },
    searchBranchCursorController.handle,
  );

  app.patch(
    "/update-branch/:branchId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Update a branch",
        description:
          "Update existing branch information including location details, contact information, and operational settings",
        params: branchSchemas.updateDeleteBranch,
        body: branchSchemas.updateBranch,
        response: {
          200: branchResponses.branchUpdated,
          400: branchResponses.updateBranchErrors,
          403: branchResponses.updateBranchForbidden,
          404: branchResponses.updateBranchNotFound,
          500: branchResponses.internalServerError,
        },
      },
    },
    updateBranchController.handle,
  );

  app.delete(
    "/delete-branch/:branchId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Delete a branch",
        description:
          "Permanently remove a branch location and all associated operational data from the system",
        params: branchSchemas.updateDeleteBranch,
        response: {
          200: branchResponses.branchDeleted,
          400: branchResponses.deleteBranchErrors,
          403: branchResponses.deleteBranchForbidden,
          404: branchResponses.deleteBranchNotFound,
          500: branchResponses.internalServerError,
        },
      },
    },
    deleteBranchController.handle,
  );
}

export { branchRoutes };
