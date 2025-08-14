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
        summary: "Create a new permission",
        description: "Register a new system permission with access control rules and resource restrictions",
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
        summary: "List permissions",
        description: "Retrieve a paginated list of system permissions with their access control configurations",
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
        summary: "Update a permission",
        description: "Update existing permission settings including access rules and resource restrictions",
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
        summary: "Delete a permission",
        description: "Permanently remove a permission from the system access control configuration",
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
