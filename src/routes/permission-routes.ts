import { FastifyInstance } from "fastify";

import { CreatePermissionController } from "@/modules/permission/usecases/create-permission/create-permission-controller";
import { ListPermissionController } from "@/modules/permission/usecases/list-permission/list-permission-controller";

import { DeletePermissionController } from "@/modules/permission/usecases/delete-permission/delete-permission-controller";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { UpdatePermissionController } from "@/modules/permission/usecases/update-permission/update-permission-controller";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { BulkConfigurePermissionsController } from "@/modules/permission/usecases/bulk-configure-permissions/bulk-configure-permissions-controller";
import { ListPermissionsByProfileController } from "@/modules/permission/usecases/list-permissions-by-profile/list-permissions-by-profile-controller";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  permissionResponses,
  permissionSchemas,
} from "./documentation/permission-documentation";
import { ndjsonList, offsetMetaWith } from "./documentation/ndjson";

const createPermissionController = new CreatePermissionController();
const listPermissionController = new ListPermissionController();

const updatePermissionController = new UpdatePermissionController();
const deletePermissionController = new DeletePermissionController();

const bulkConfigurePermissionsController =
  new BulkConfigurePermissionsController();
const listPermissionsByProfileController =
  new ListPermissionsByProfileController();

async function permissionRoutes(app: FastifyInstance) {
  app.post(
    "/create-permission",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("user_permission_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        summary: "Cria uma permissão num perfil de acesso",
        description:
          "Concede a um perfil de acesso a leitura (e, se marcada, a escrita) de um recurso. Leitura é obrigatória. Um usuário comum não concede nada ao próprio perfil.",
        body: permissionSchemas.createPermission,
        response: {
          201: permissionResponses.permissionCreated,
          400: permissionResponses.createPermissionErrors,
          403: permissionResponses.permissionWriteForbidden,
          404: permissionResponses.permissionWriteNotFound,
          409: permissionResponses.permissionWriteConflict,
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
        summary: "Lista as permissões de uma empresa",
        description:
          "Página de permissões com busca, ordenação e filtros no servidor (recurso, perfil, leitura, escrita). A linha de meta traz em `searchMeta` as contagens e as opções dos filtros, sobre a empresa inteira. O MASTER informa `businessId`; os demais listam a própria empresa, e um usuário comum não vê as permissões do próprio perfil.",
        querystring: permissionSchemas.listPermission,
        response: {
          200: ndjsonList(
            permissionResponses.permissionListRow,
            offsetMetaWith(permissionResponses.permissionListSearchMeta),
          ),
          400: permissionResponses.listPermissionErrors,
          404: permissionResponses.businessNotFound,
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
      preHandler: [
        verifyBusinessActive,
        verifyPermission("user_permission_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        summary: "Atualiza uma permissão",
        description:
          "Altera o nome, o recurso, o perfil (da mesma empresa) ou a leitura/escrita de uma permissão. A empresa é a da permissão e não muda (decisão 16.100): um `businessId` no corpo responde 400 VALIDATION_ERROR, e um perfil de outra empresa, 400 PROFILE_ACCESS_NOT_FOUND. As sessões da empresa releem as permissões na hora. Um usuário comum não altera as permissões do próprio perfil nem move uma permissão para ele.",
        params: permissionSchemas.updateDeletePermission,
        body: permissionSchemas.updatePermission,
        response: {
          200: permissionResponses.permissionUpdated,
          400: permissionResponses.updatePermissionErrors,
          403: permissionResponses.permissionWriteForbidden,
          404: permissionResponses.permissionWriteNotFound,
          409: permissionResponses.permissionWriteConflict,
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
        summary: "Exclui uma permissão",
        description:
          "Remove a permissão do perfil. Quem usa o perfil perde o acesso ao recurso na hora.",
        params: permissionSchemas.updateDeletePermission,
        response: {
          200: permissionResponses.permissionDeleted,
          400: permissionResponses.deletePermissionErrors,
          403: permissionResponses.permissionWriteForbidden,
          404: permissionResponses.permissionWriteNotFound,
          500: permissionResponses.internalServerError,
        },
      },
    },
    deletePermissionController.handle,
  );

  app.post(
    "/bulk-configure-permissions",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("user_permission_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        summary: "Configura todas as permissões de um perfil de uma vez",
        description:
          "Substitui, numa só transação, todas as permissões do perfil pelo conjunto enviado. Toda linha precisa de leitura e cada recurso aparece uma vez (400 caso contrário). Um usuário comum não configura o próprio perfil.",
        body: permissionSchemas.bulkConfigurePermissions,
        response: {
          200: permissionResponses.permissionsConfigured,
          400: permissionResponses.bulkConfigurePermissionsErrors,
          403: permissionResponses.permissionWriteForbidden,
          404: permissionResponses.permissionWriteNotFound,
          500: permissionResponses.internalServerError,
        },
      },
    },
    bulkConfigurePermissionsController.handle,
  );

  app.get(
    "/list-by-profile/:profileAccessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_permission_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["permission"],
        summary: "Lista as permissões de um perfil",
        description:
          "Devolve todas as permissões atribuídas a um perfil de acesso.",
        params: permissionSchemas.listByProfile,
        querystring: permissionSchemas.listByProfileQuery,
        response: {
          200: permissionResponses.permissionsByProfile,
          400: permissionResponses.listPermissionErrors,
          404: permissionResponses.resourceNotFound,
          500: permissionResponses.internalServerError,
        },
      },
    },
    listPermissionsByProfileController.handle,
  );
}

export { permissionRoutes };
