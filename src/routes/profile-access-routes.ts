import { FastifyInstance } from "fastify";

import { CreateProfileAccessController } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-controller";
import { ListProfileAccessController } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-controller";

import { DeleteProfileAccessController } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-controller";
import { UpdateProfileAccessController } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-controller";

import { ListProfileBusinessController } from "@/modules/profile-access/usecases/list-profile-business/list-profile-business-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  profileAccessResponses,
  profileAccessSchemas,
} from "./documentation/profile-access-documentation";

const createProfileAccessController = new CreateProfileAccessController();
const listProfileAccessController = new ListProfileAccessController();

const listProfileBusinessController = new ListProfileBusinessController();

const updateProfileAccessController = new UpdateProfileAccessController();
const deleteProfileAccessController = new DeleteProfileAccessController();

async function profileAccessRoutes(app: FastifyInstance) {
  app.post(
    "/create-profile-access",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        description: "Create new profile access",
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
        description: "List profile access",
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
    "/list-profile-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        description: "List profile business",
        querystring: profileAccessSchemas.listProfileBusiness,
        response: {
          200: profileAccessResponses.profileBusinessList,
          400: profileAccessResponses.listProfileBusinessErrors,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    listProfileBusinessController.handle,
  );

  app.patch(
    "/update-profile-access/:profileAccessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("profile_access_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["profile-access"],
        description: "Update profile access",
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
        description: "Delete profile access",
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
