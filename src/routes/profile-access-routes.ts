import { FastifyInstance } from "fastify";

import { CreateProfileAccessController } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-controller";
import { ListProfileAccessController } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-controller";

import { DeleteProfileAccessController } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-controller";
import { UpdateProfileAccessController } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-controller";

import { SearchProfileCursorController } from "@/modules/profile-access/usecases/search-profile-cursor/search-profile-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  profileAccessResponses,
  profileAccessSchemas,
} from "./documentation/profile-access-documentation";

const createProfileAccessController = new CreateProfileAccessController();
const listProfileAccessController = new ListProfileAccessController();

const searchProfileCursorController = new SearchProfileCursorController();

const updateProfileAccessController = new UpdateProfileAccessController();
const deleteProfileAccessController = new DeleteProfileAccessController();

async function profileAccessRoutes(app: FastifyInstance) {
  app.post(
    "/create-profile-access",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("profile_access_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        summary: "Create a new profile access",
        description:
          "Register a new user profile access template with permission sets and role configurations",
        body: profileAccessSchemas.createProfileAccess,
        response: {
          201: profileAccessResponses.profileAccessCreated,
          400: profileAccessResponses.createProfileAccessErrors,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    createProfileAccessController.handle,
  );

  app.get(
    "/list-profile-access",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        summary: "List profile access",
        description:
          "Retrieve a paginated list of user profile access templates with their permission configurations",
        querystring: profileAccessSchemas.listProfileAccess,
        response: {
          200: profileAccessResponses.profileAccessList,
          400: profileAccessResponses.listProfileAccessErrors,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    listProfileAccessController.handle,
  );

  app.get(
    "/search-profile-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        summary: "Search profiles by business (cursor-based)",
        description:
          "Retrieve profile access templates as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual profile access objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: profileAccessSchemas.searchProfileCursor,
        response: {
          200: profileAccessResponses.searchProfileStreamDescription,
          400: profileAccessResponses.listProfileBusinessErrors,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    searchProfileCursorController.handle,
  );

  app.patch(
    "/update-profile-access/:profileAccessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("profile_access_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        summary: "Update a profile access",
        description:
          "Update existing profile access template including permission sets and role configurations",
        params: profileAccessSchemas.updateDeleteProfileAccess,
        body: profileAccessSchemas.updateProfileAccess,
        response: {
          200: profileAccessResponses.profileAccessUpdated,
          400: profileAccessResponses.updateProfileAccessErrors,
          403: profileAccessResponses.profileAccessCannotBeUpdatedByHimself,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    updateProfileAccessController.handle,
  );

  app.delete(
    "/delete-profile-access/:profileAccessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        summary: "Delete a profile access",
        description:
          "Permanently remove a profile access template and revoke associated user permissions",
        params: profileAccessSchemas.updateDeleteProfileAccess,
        response: {
          200: profileAccessResponses.profileAccessDeleted,
          400: profileAccessResponses.deleteProfileAccessErrors,
          403: profileAccessResponses.profileAccessCannotBeDeletedByHimself,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    deleteProfileAccessController.handle,
  );
}

export { profileAccessRoutes };
