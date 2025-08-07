import { FastifyInstance } from "fastify";

import { CreatePermissionController } from "@/modules/permission/usecases/create-permission/create-permission-controller";
import { ListPermissionController } from "@/modules/permission/usecases/list-permission/list-permission-controller";

import { DeletePermissionController } from "@/modules/permission/usecases/delete-permission/delete-permission-controller";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { UpdatePermissionController } from "@/modules/permission/usecases/update-permission/update-permission-controller";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  permissionResponses,
  permissionSchemas,
} from "./documentation/permission-documentation";

const createPermissionController = new CreatePermissionController();
const listPermissionController = new ListPermissionController();

const updatePermissionController = new UpdatePermissionController();
const deletePermissionController = new DeletePermissionController();

async function permissionRoutes(app: FastifyInstance) {
  app.post(
    "/create-permission",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_permission_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        description: "Create new permission",
        body: permissionSchemas.createPermission,
        response: {
          201: permissionResponses.permissionCreated,
          400: permissionResponses.createPermissionErrors,
          500: permissionResponses.internalServerError,
        },
      },
    },
    createPermissionController.handle,
  );

  app.get(
    "/list-permission",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_permission_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        description: "List permissions",
        querystring: permissionSchemas.listPermission,
        response: {
          200: permissionResponses.permissionList,
          400: permissionResponses.listPermissionErrors,
          500: permissionResponses.internalServerError,
        },
      },
    },
    listPermissionController.handle,
  );

  app.patch(
    "/update-permission/:permissionId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_permission_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        description: "Update permission",
        params: permissionSchemas.updateDeletePermission,
        body: permissionSchemas.updatePermission,
        response: {
          200: permissionResponses.permissionUpdated,
          400: permissionResponses.updatePermissionErrors,
          403: permissionResponses.permissionCannotBeUpdatedByHimself,
          500: permissionResponses.internalServerError,
        },
      },
    },
    updatePermissionController.handle,
  );

  app.delete(
    "/delete-permission/:permissionId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_permission_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        description: "Delete permission",
        params: permissionSchemas.updateDeletePermission,
        response: {
          200: permissionResponses.permissionDeleted,
          400: permissionResponses.deletePermissionErrors,
          403: permissionResponses.permissionCannotBeDeletedByHimself,
          500: permissionResponses.internalServerError,
        },
      },
    },
    deletePermissionController.handle,
  );
}

export { permissionRoutes };
