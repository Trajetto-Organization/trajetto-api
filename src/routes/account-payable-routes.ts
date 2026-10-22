import { FastifyInstance } from "fastify";

import { CreateAccountPayableController } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-controller";
import { ListAccountPayableController } from "@/modules/account-payable/usecases/list-account-payable/list-account-payable-controller";

import { SearchAccountPayableCursorController } from "@/modules/account-payable/usecases/search-account-payable-cursor/search-account-payable-cursor-controller";
import { ExportAccountPayableController } from "@/modules/account-payable/usecases/export-account-payable/export-account-payable-controller";

import { UpdateAccountPayableController } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-controller";
import { DeleteAccountPayableController } from "@/modules/account-payable/usecases/delete-account-payable/delete-account-payable-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import {
  accountPayableSchemas,
  accountPayableResponses,
} from "./documentation/account-payable-documentation";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { panelIdempotencyHeaders } from "./documentation/idempotency-documentation";
import { exportFileResponse } from "./documentation/doc-only-responses";

const createAccountPayableController = new CreateAccountPayableController();
const listAccountPayableController = new ListAccountPayableController();

const searchAccountPayableCursorController =
  new SearchAccountPayableCursorController();
const exportAccountPayableController = new ExportAccountPayableController();

const updateAccountPayableController = new UpdateAccountPayableController();
const deleteAccountPayableController = new DeleteAccountPayableController();

async function accountPayableRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest).
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-account-payable/:businessId",
    {
      // Documentation only; see idempotency-documentation (IDEMP-14).
      config: { openapi: { headers: panelIdempotencyHeaders } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("account_payable_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Registra uma conta a pagar",
        description:
          "Registra uma conta: categoria, favorecido (um fornecedor cadastrado OU um nome livre, obrigatório), veículo como centro de custo, descrição, número do documento, datas (AAAA-MM-DD, no fuso da empresa), valores, filial, ordem de serviço e o responsável — avisado da conta, e que pode ser um motorista. Quem registrou é gravado a partir da sessão. Todo vínculo precisa ser da mesma empresa. Avisa (sem recusar) quando a soma das contas de uma ordem de serviço passa do total dela.",
        params: accountPayableSchemas.businessIdParam,
        body: accountPayableSchemas.createAccountPayable,
        response: {
          201: accountPayableResponses.accountPayableCreated,
          400: accountPayableResponses.writeErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    createAccountPayableController.handle,
  );

  app.get(
    "/list-account-payable",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("account_payable_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Lista as contas a pagar da empresa",
        description:
          "Contas de uma empresa numa tabela paginada. A situação de cada conta (`status`, `status_group`) é calculada no servidor pelo dia de negócio da empresa: a conta vence só depois do dia do vencimento. Ordena no servidor (`sort`/`order`; a situação não é ordenável — ordene pelo vencimento) e filtra por situação e categoria, além da busca livre (IDs, descrição, documento, favorecido, fornecedor, placa, responsável, filial ou valor exato). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (em aberto, vencidas, quitadas, com os valores) e as opções do filtro de situação com as contagens — sobre a empresa inteira. O MASTER informa `businessId`.",
        querystring: accountPayableSchemas.listAccountPayable,
        response: {
          200: ndjsonList(
            accountPayableResponses.accountPayableRow,
            offsetMetaWith(accountPayableResponses.accountPayableSearchMeta),
          ),
          400: accountPayableResponses.listErrors,
          404: accountPayableResponses.notFound,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    listAccountPayableController.handle,
  );

  app.get(
    "/export-account-payable",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("account_payable_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Exporta as contas a pagar (CSV ou Excel)",
        description:
          "As contas da busca, dos filtros e da ordenação da listagem, com a mesma situação calculada no servidor, o favorecido, o veículo, o documento, a descrição, o responsável e quem registrou. `format=csv|excel`. O MASTER informa `businessId`. Exportar exige escrita, como nas demais exportações.",
        querystring: accountPayableSchemas.exportAccountPayable,
        response: {
          200: exportFileResponse("relatorio-contas-a-pagar-<AAAA-MM-DD>"),
          400: accountPayableResponses.exportErrors,
          404: accountPayableResponses.notFound,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    exportAccountPayableController.handle,
  );

  app.get(
    "/search-account-payable-by-responsible-user",
    {
      onRequest: [ensureAuthenticated],

      // Self-scoped, no profile permission (decision 4.5, AP-DRV-1): the use
      // case reads only the bills whose responsible is the caller, in the
      // caller's company — both from the session. A driver can be that
      // responsible and is sent here by the notification; requiring
      // account_payable_manage answered them 403. Adding the key to the
      // driver map instead would open the company-wide list above.
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Minhas contas a pagar (cursor)",
        description:
          "As contas em que o usuário autenticado é o RESPONSÁVEL, na empresa dele — inclusive o motorista. Sem permissão de perfil: a rota só devolve as próprias contas (usuário e empresa vêm da sessão), com a situação calculada pelo dia de negócio da empresa. `search` filtra por ID, descrição, documento, favorecido, fornecedor, placa, ordem de serviço ou valor exato. NDJSON por cursor: a primeira linha traz `meta.searchMeta.{nextCursor, hasMore}`.",
        querystring: accountPayableSchemas.searchAccountPayableCursor,
        response: {
          200: ndjsonCursor(accountPayableResponses.accountPayableRow),
          400: accountPayableResponses.searchErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    searchAccountPayableCursorController.handle,
  );

  app.patch(
    "/update-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("account_payable_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Atualiza uma conta a pagar",
        description:
          "Atualiza os campos enviados; ausente é inalterado (os obrigatórios não aceitam nulo). A conta precisa ser da empresa do caminho — conta não muda de empresa, nem pelo MASTER. Trocar o responsável avisa o novo. Informar um fornecedor limpa o favorecido livre e vice-versa; uma conta com favorecido não fica sem ele (400 ACCOUNT_PAYABLE_PAYEE_REQUIRED), enquanto uma conta antiga, sem favorecido, pode ser editada sem informar um. Avisa (sem recusar) quando a soma das contas da ordem de serviço passa do total dela.",
        params: accountPayableSchemas.accountPayableBusinessParams,
        body: accountPayableSchemas.updateAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableUpdated,
          400: accountPayableResponses.writeErrors,
          403: accountPayableResponses.forbidden,
          404: accountPayableResponses.notFound,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    updateAccountPayableController.handle,
  );

  app.delete(
    "/delete-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // The company check the other writes have: an inactive company is not
      // operated, by the MASTER either (TENANT_INACTIVE).
      preHandler: [
        verifyBusinessActive,
        verifyPermission("account_payable_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Exclui uma conta a pagar em aberto",
        description:
          "Exclui só uma conta sem pagamento registrado, da empresa do caminho. Conta paga é registro financeiro e fica: 409 ACCOUNT_PAYABLE_ALREADY_PAID.",
        params: accountPayableSchemas.accountPayableBusinessParams,
        response: {
          200: accountPayableResponses.accountPayableDeleted,
          400: accountPayableResponses.deleteErrors,
          403: accountPayableResponses.forbidden,
          404: accountPayableResponses.notFound,
          409: accountPayableResponses.alreadyPaid,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    deleteAccountPayableController.handle,
  );
}

export { accountPayableRoutes };
