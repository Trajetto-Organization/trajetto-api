import { FastifyInstance } from "fastify";

import { CreateBusinessController } from "@/modules/business/usecases/create-business/create-business-controller";
import { ListBusinessController } from "@/modules/business/usecases/list-business/list-business-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { DeleteBusinessController } from "@/modules/business/usecases/delete-business/delete-business-controller";

import { UpdateBusinessController } from "@/modules/business/usecases/update-business/update-business-controller";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import {
  businessResponses,
  businessSchemas,
} from "./documentation/business-documentation";

const createBusinessController = new CreateBusinessController();
const listBusinessController = new ListBusinessController();

const deleteBusinessController = new DeleteBusinessController();
const updateBusinessController = new UpdateBusinessController();

async function businessRoutes(app: FastifyInstance) {
  app.post(
    "/create-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        description: "Create a new business",
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
      preHandler: [verifyPermission("profile_access_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        description: "List a business",
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

  app.patch(
    "/update-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        description: "Update business information",
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

  app.delete(
    "/delete-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        description: "Delete a business",
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
