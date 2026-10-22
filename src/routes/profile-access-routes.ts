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
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { profileAccessListSearchMetaDoc } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-documentation";

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
        summary: "Cria um perfil de acesso",
        description:
          "Cadastra um perfil de acesso na empresa. As permissões do perfil são configuradas depois (permissões em lote ou uma a uma). Avisa as outras abas da empresa (catalogChanged profile_access).",
        body: profileAccessSchemas.createProfileAccess,
        response: {
          201: profileAccessResponses.profileAccessCreated,
          400: profileAccessResponses.createProfileAccessErrors,
          404: profileAccessResponses.lookupNotFound,
          409: profileAccessResponses.profileAccessConflict,
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
        summary: "Lista os perfis de acesso de uma empresa",
        description:
          "Página de perfis com busca e ordenação no servidor, cada um com quantos usuários e permissões tem. O MASTER informa `businessId`; os demais listam a própria empresa, e um usuário comum não vê o próprio perfil. A linha `meta.searchMeta` traz os cartões da tela sobre toda a busca (não só a página): total de perfis, usuários vinculados, perfis sem usuários e o perfil mais usado.",
        querystring: profileAccessSchemas.listProfileAccess,
        response: {
          200: ndjsonList(
            profileAccessResponses.profileAccessListRow,
            offsetMetaWith(profileAccessListSearchMetaDoc),
          ),
          400: profileAccessResponses.listProfileAccessErrors,
          404: profileAccessResponses.lookupNotFound,
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
        summary: "Busca perfis de acesso da empresa (cursor)",
        description:
          "Perfis da empresa em NDJSON paginado por cursor, para os seletores. " +
          "O termo em `search` é comparado com o nome no servidor. " +
          "Com `editable=true` (formulário de permissões), um usuário comum não recebe o próprio perfil. " +
          "A primeira linha traz {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; " +
          "use nextCursor como `cursor` da próxima página.",
        querystring: profileAccessSchemas.searchProfileCursor,
        response: {
          200: ndjsonCursor(profileAccessResponses.profileAccessRow),
          400: profileAccessResponses.listProfileBusinessErrors,
          404: profileAccessResponses.lookupNotFound,
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
        summary: "Renomeia um perfil de acesso",
        description:
          "Altera o nome do perfil. O perfil não muda de empresa (decisão 16.100): um `businessId` no corpo, com qualquer valor, responde 400 VALIDATION_ERROR. Avisa as outras abas da empresa (catalogChanged profile_access).",
        params: profileAccessSchemas.updateDeleteProfileAccess,
        body: profileAccessSchemas.updateProfileAccess,
        response: {
          200: profileAccessResponses.profileAccessUpdated,
          400: profileAccessResponses.updateProfileAccessErrors,
          403: profileAccessResponses.profileAccessCannotBeUpdatedByHimself,
          404: profileAccessResponses.profileAccessWriteNotFound,
          409: profileAccessResponses.profileAccessConflict,
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
        summary: "Exclui um perfil de acesso",
        description:
          "Exclui o perfil e as permissões dele. Um perfil ainda ligado a usuários é recusado com 409 PROFILE_ACCESS_IN_USE e a contagem: excluí-lo deixaria essas pessoas sem acesso.",
        params: profileAccessSchemas.updateDeleteProfileAccess,
        response: {
          200: profileAccessResponses.profileAccessDeleted,
          400: profileAccessResponses.deleteProfileAccessErrors,
          403: profileAccessResponses.profileAccessCannotBeDeletedByHimself,
          404: profileAccessResponses.profileAccessWriteNotFound,
          409: profileAccessResponses.profileAccessInUse,
          500: profileAccessResponses.internalServerError,
        },
      },
    },
    deleteProfileAccessController.handle,
  );
}

export { profileAccessRoutes };
