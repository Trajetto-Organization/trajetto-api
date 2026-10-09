import { FastifyInstance } from "fastify";

import { CreateBranchController } from "@/modules/branch/usecases/create-branch/create-branch-controller";
import { DeleteBranchController } from "@/modules/branch/usecases/delete-branch/delete-branch-controller";

import { RequestBranchDeletionController } from "@/modules/branch/usecases/request-branch-deletion/request-branch-deletion-controller";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ListBranchController } from "@/modules/branch/usecases/list-branch/list-branch-controller";
import { UpdateBranchController } from "@/modules/branch/usecases/update-branch/update-branch-controller";

import { SearchBranchCursorController } from "@/modules/branch/usecases/search-branch-cursor/search-branch-cursor-controller";
import { ToggleBranchActiveController } from "@/modules/branch/usecases/toggle-branch-active/toggle-branch-active-controller";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  branchResponses,
  branchSchemas,
} from "./documentation/branch-documentation";
import { ndjsonCursor, ndjsonList, offsetMetaWith } from "./documentation/ndjson";

const createBranchController = new CreateBranchController();
const deleteBranchController = new DeleteBranchController();

const requestBranchDeletionController = new RequestBranchDeletionController();

const updateBranchController = new UpdateBranchController();
const listBranchController = new ListBranchController();

const searchBranchCursorController = new SearchBranchCursorController();
const toggleBranchActiveController = new ToggleBranchActiveController();

async function branchRoutes(app: FastifyInstance) {
  app.post(
    "/create-branch/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("branch_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Cadastra uma filial",
        description:
          "Cadastra uma filial da empresa do caminho. Razão social (sem diferenciar maiúsculas), e-mail e código ERP são únicos DENTRO da empresa — outra transportadora pode ter uma filial igual, e a resposta nunca a cita. O CNPJ é único na plataforma (identidade nacional) e o conflito responde com mensagem neutra. Avisa as outras telas abertas pelo evento `catalogChanged` (entidade `branch`).",
        params: branchSchemas.businessIdParam,
        body: branchSchemas.createBranch,
        response: {
          201: branchResponses.branchCreated,
          400: branchResponses.createBranchErrors,
          403: branchResponses.branchForbidden,
          409: branchResponses.branchConflict,
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
        summary: "Lista as filiais da empresa",
        description:
          "Filiais de uma empresa numa tabela paginada. Ordena no servidor (`sort`/`order`) e filtra por situação (`status`: active, inactive) e UF (um ou mais valores separados por vírgula), além da busca livre (ID, razão social, nome fantasia, endereço, CNAE, código ERP, responsável, e-mail e os dígitos de CNPJ, CEP e telefone). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (total, ativas, com código ERP, com nome fantasia) e as opções dos filtros com as contagens — calculados sobre a empresa inteira, nunca sobre a página. O MASTER informa `businessId`.",
        querystring: branchSchemas.listBranch,
        response: {
          200: ndjsonList(
            branchResponses.branchRow,
            offsetMetaWith(branchResponses.branchListSearchMeta),
          ),
          400: branchResponses.listBranchErrors,
          403: branchResponses.branchForbidden,
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
        summary: "Busca filiais ativas da empresa (cursor)",
        description:
          "As filiais ativas de uma empresa para os seletores, em NDJSON paginado por cursor, mais recentes primeiro. `search` filtra no servidor por razão social, nome fantasia, CNPJ, cidade, UF ou e-mail. A primeira linha traz `meta.searchMeta.{nextCursor, hasMore}`; passe `nextCursor` como `cursor` para a próxima página.",
        querystring: branchSchemas.searchBranchCursor,
        response: {
          200: ndjsonCursor(branchResponses.branchRow),
          400: branchResponses.searchBranchErrors,
          403: branchResponses.branchForbidden,
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
      preHandler: [
        verifyBusinessActive,
        verifyPermission("branch_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Atualiza uma filial",
        description:
          "Atualiza só os campos enviados (um campo ausente fica como está). A filial precisa ser da empresa do caminho — filial não muda de empresa, nem pelo MASTER; a de outra empresa responde 404. As regras de unicidade são as do cadastro. Avisa as outras telas pelo evento `catalogChanged`.",
        params: branchSchemas.updateDeleteBranch,
        body: branchSchemas.updateBranch,
        response: {
          200: branchResponses.branchUpdated,
          400: branchResponses.updateBranchErrors,
          403: branchResponses.branchForbidden,
          404: branchResponses.branchNotFound,
          409: branchResponses.branchConflict,
          500: branchResponses.internalServerError,
        },
      },
    },
    updateBranchController.handle,
  );

  app.post(
    "/request-branch-deletion/:branchId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Pede a exclusão de uma filial (envia o código)",
        description:
          "Primeiro passo da exclusão em duas etapas. Confere que a filial pode ser excluída (sem vínculos) e envia um código de 6 dígitos ao e-mail de quem pediu, válido por 5 minutos. Use a rota DELETE com o código para excluir.",
        params: branchSchemas.updateDeleteBranch,
        response: {
          200: branchResponses.branchDeletionCodeSent,
          400: branchResponses.requestBranchDeletionErrors,
          403: branchResponses.branchForbidden,
          404: branchResponses.branchOrBusinessNotFound,
          409: branchResponses.branchInUse,
          500: branchResponses.internalServerError,
        },
      },
    },
    requestBranchDeletionController.handle,
  );

  app.delete(
    "/delete-branch/:branchId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("branch_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Confirma a exclusão de uma filial (com o código)",
        description:
          "Segundo passo da exclusão. Valida o código de 6 dígitos recebido por e-mail e exclui a filial. Depois, os demais administradores da empresa recebem um aviso por e-mail, com a hora no fuso da empresa. Avisa as outras telas pelo evento `catalogChanged`.",
        params: branchSchemas.updateDeleteBranch,
        body: branchSchemas.confirmDeletionCode,
        response: {
          200: branchResponses.branchDeleted,
          400: branchResponses.confirmBranchDeletionErrors,
          403: branchResponses.branchForbidden,
          404: branchResponses.branchOrBusinessNotFound,
          409: branchResponses.branchDeletionConflict,
          500: branchResponses.internalServerError,
        },
      },
    },
    deleteBranchController.handle,
  );

  app.patch(
    "/toggle-branch-active/:branchId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("branch_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["branch"],
        summary: "Ativa ou inativa uma filial",
        description:
          "Inverte a situação da filial. Filial inativa sai dos seletores. Se o status mudou enquanto a tela estava aberta, nada é gravado (409 TOGGLE_CONFLICT). Avisa as outras telas pelo evento `catalogChanged`.",
        params: branchSchemas.updateDeleteBranch,
        response: {
          200: branchResponses.branchToggled,
          400: branchResponses.toggleBranchErrors,
          403: branchResponses.branchForbidden,
          404: branchResponses.branchNotFound,
          409: branchResponses.branchConflict,
          500: branchResponses.internalServerError,
        },
      },
    },
    toggleBranchActiveController.handle,
  );
}

export { branchRoutes };
