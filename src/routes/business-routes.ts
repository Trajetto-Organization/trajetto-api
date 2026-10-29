import { FastifyInstance } from "fastify";
import { z } from "zod";

import { CreateBusinessController } from "@/modules/business/usecases/create-business/create-business-controller";
import { ListBusinessController } from "@/modules/business/usecases/list-business/list-business-controller";

import { SearchBusinessCursorController } from "@/modules/business/usecases/search-business-cursor/search-business-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { DeleteBusinessController } from "@/modules/business/usecases/delete-business/delete-business-controller";

import { UpdateBusinessController } from "@/modules/business/usecases/update-business/update-business-controller";
import { ToggleBusinessActiveController } from "@/modules/business/usecases/toggle-business-active/toggle-business-active-controller";

import { RequestBusinessDeletionController } from "@/modules/business/usecases/request-business-deletion/request-business-deletion-controller";
import { UpdateAILimitController } from "@/modules/business/usecases/update-ai-limit/update-ai-limit-controller";
import { UpdateVehicleLimitController } from "@/modules/business/usecases/update-vehicle-limit/update-vehicle-limit-controller";
import {
  GetBusinessEntitlementsController,
  GetModuleImpactController,
  UpdateBusinessEntitlementController,
} from "@/modules/business/usecases/manage-entitlements/manage-entitlements-controller";

import { GetAIUsageController } from "@/modules/business/usecases/get-ai-usage/get-ai-usage-controller";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import {
  businessResponses,
  businessSchemas,
} from "./documentation/business-documentation";
import {
  authBusyResponse,
  errorResponse,
} from "./documentation/common-responses";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";

const createBusinessController = new CreateBusinessController();
const listBusinessController = new ListBusinessController();

const searchBusinessCursorController = new SearchBusinessCursorController();

const deleteBusinessController = new DeleteBusinessController();
const requestBusinessDeletionController =
  new RequestBusinessDeletionController();

const updateBusinessController = new UpdateBusinessController();
const toggleBusinessActiveController = new ToggleBusinessActiveController();

const updateAILimitController = new UpdateAILimitController();
const updateVehicleLimitController = new UpdateVehicleLimitController();

const getBusinessEntitlementsController =
  new GetBusinessEntitlementsController();
const updateBusinessEntitlementController =
  new UpdateBusinessEntitlementController();
const getModuleImpactController = new GetModuleImpactController();
const getAIUsageController = new GetAIUsageController();

async function businessRoutes(app: FastifyInstance) {
  app.post(
    "/create-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Cadastra uma empresa",
        description:
          'Cadastra uma transportadora (tenant) e a filial matriz com os mesmos dados. CNPJ, razão social, e-mail e código ERP da empresa são únicos na plataforma. `timezone` (opcional) é um dos fusos do Brasil e define o "hoje" da empresa; ausente, America/Sao_Paulo. Só o MASTER.',
        body: businessSchemas.createBusiness,
        response: {
          201: businessResponses.businessCreated,
          400: businessResponses.createBusinessErrors,
          409: businessResponses.businessConflict,
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
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Lista as empresas (tabela do /admin)",
        description:
          "Empresas numa tabela paginada, só para o MASTER. Ordena no servidor (`sort`/`order`) e filtra por situação (`status`: active, inactive) e UF (um ou mais valores separados por vírgula), além da busca livre (ID, razão social, nome fantasia, endereço, CNAE, código ERP, responsável, e-mail e os dígitos de CNPJ, CEP e telefone). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (total, com código ERP, principais estados e cidades) e as opções dos filtros com as contagens — calculados sobre todas as empresas, nunca sobre a página.",
        querystring: businessSchemas.listBusiness,
        response: {
          200: ndjsonList(
            businessResponses.businessRow,
            offsetMetaWith(businessResponses.businessListSearchMeta),
          ),
          400: z.union([
            businessResponses.listBusinessCodedErrors,
            businessResponses.listBusinessErrors,
          ]),
          403: businessResponses.listBusinessCodedErrors.describe(
            "PERMISSION_DENIED: só o MASTER lista as empresas.",
          ),
          500: businessResponses.internalServerError,
        },
      },
    },
    listBusinessController.handle,
  );

  app.get(
    "/search-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Busca empresas para o seletor (paginação por cursor)",
        description:
          "Devolve as empresas ativas em NDJSON, com paginação por cursor, para o seletor de empresa do /admin. " +
          "A primeira linha traz o meta: {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; as seguintes, uma empresa por linha. " +
          "O termo digitado (search) é buscado no servidor, sem diferenciar maiúsculas e como texto literal (% e _ não são curingas), " +
          "na razão social, no nome fantasia, no CNPJ, no e-mail e no responsável. " +
          "Use o nextCursor como cursor da próxima página.",
        querystring: businessSchemas.searchBusinessCursor,
        response: {
          // The picker reads the plain rows: no fleet count there.
          200: ndjsonCursor(
            businessResponses.businessRow.partial({ vehicle_count: true }),
          ),
          400: businessResponses.listBusinessErrors,
          500: businessResponses.internalServerError,
        },
      },
    },
    searchBusinessCursorController.handle,
  );

  app.patch(
    "/update-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Atualiza uma empresa",
        description:
          'Atualiza os campos enviados da empresa e os espelha na filial matriz (exceto o fuso, que é só da empresa). `timezone` aceita apenas fusos do Brasil; trocá-lo muda o "hoje" de todos os painéis e relatórios da empresa. Só o MASTER.',
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateBusiness,
        response: {
          200: businessResponses.businessUpdated,
          400: businessResponses.updateBusinessErrors,
          404: businessResponses.businessNotFoundCoded,
          409: businessResponses.businessConflict,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateBusinessController.handle,
  );

  app.patch(
    "/update-ai-limit/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Atualiza o limite mensal de análises de IA da empresa",
        description:
          "Define quantas análises de IA a empresa pode fazer por mês. O limite 0 desliga a análise de IA para a empresa.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateAILimit,
        response: {
          200: businessResponses.aiLimitUpdated,
          400: businessResponses.businessParamErrors,
          404: businessResponses.businessNotFoundCodedPath,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateAILimitController.handle,
  );

  app.patch(
    "/update-vehicle-limit/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Atualiza o limite de veículos contratado pela empresa",
        description:
          "Define o tamanho de frota contratado (base da cobrança). 0 = não configurado, nunca bloqueia. Baixar o limite abaixo da frota atual mantém os veículos existentes e só bloqueia novos cadastros.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateVehicleLimit,
        response: {
          200: businessResponses.vehicleLimitUpdated,
          400: businessResponses.businessParamErrors,
          404: businessResponses.businessNotFoundCodedPath,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateVehicleLimitController.handle,
  );

  app.get(
    "/get-ai-usage/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Consulta o uso de análises de IA da empresa",
        description:
          "Devolve o limite, o saldo e o uso de análises de IA da empresa no mês corrente — o mês civil no fuso da empresa (`ai_analysis_timezone`), de `ai_analysis_reset_at` até `ai_analysis_next_reset_at`. Cada unidade é uma foto lida (odômetro, item de checklist ou canhoto de entrega), com a quebra por tipo em `ai_analysis_used_by_type`. Só o MASTER e o administrador da própria empresa: outros papéis recebem 403 AUTH_ROLE_FORBIDDEN, e o id de outra empresa, 403 TENANT_ACCESS_DENIED. Empresa inexistente: 404 BUSINESS_NOT_FOUND.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.aiUsageData,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          429: errorResponse,
          500: businessResponses.internalServerError,
        },
      },
    },
    getAIUsageController.handle,
  );

  app.get(
    "/entitlements/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary:
          "Consulta o plano da empresa: módulos contratados e uso da frota",
        description:
          "Módulos contratados (FLEET, DELIVERIES), o limite de veículos contratado, quantos veículos ocupam vaga do plano (todos menos os inativos) e a frota por situação em `vehicle_status_counts`. O admin da empresa lê a própria empresa; o MASTER lê qualquer uma. Outros papéis recebem 403 AUTH_ROLE_FORBIDDEN, e o id de outra empresa, 403 TENANT_ACCESS_DENIED. Empresa inexistente: 404 BUSINESS_NOT_FOUND.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.entitlementsData,
          400: businessResponses.businessParamErrors,
          401: errorResponse,
          403: errorResponse,
          404: businessResponses.businessNotFoundCodedPath,
          429: errorResponse,
          500: businessResponses.internalServerError,
        },
      },
    },
    getBusinessEntitlementsController.handle,
  );

  app.get(
    "/entitlements/:businessId/impact/:module",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Mostra o que a empresa tem em jogo num módulo",
        description:
          "Contagens de registros, trabalho em andamento e quantos usuários perdem itens do menu se o módulo for desligado. Alimenta o diálogo de confirmação; desligar um módulo não exclui nada.",
        params: businessSchemas.moduleImpactParams,
        response: {
          200: businessResponses.moduleImpactData,
          400: businessResponses.businessParamErrors,
          404: businessResponses.businessNotFoundCodedPath,
          500: businessResponses.internalServerError,
        },
      },
    },
    getModuleImpactController.handle,
  );

  app.put(
    "/entitlements/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Liga ou desliga um módulo da empresa",
        description:
          "Liga ou desliga um módulo vendável (FLEET, DELIVERIES) da empresa. As rotas de um módulo recusam a empresa que não o tem ligado (403 MODULE_NOT_ENABLED).",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.updateEntitlement,
        response: {
          200: businessResponses.entitlementUpdated,
          400: businessResponses.businessParamErrors,
          404: businessResponses.businessNotFoundCodedPath,
          500: businessResponses.internalServerError,
        },
      },
    },
    updateBusinessEntitlementController.handle,
  );

  app.post(
    "/request-business-deletion/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Pede a exclusão de uma empresa (envia o código)",
        description:
          "Primeiro passo da exclusão em duas etapas. Confere que a empresa pode ser excluída (sem filiais, usuários ou motoristas vinculados) e envia um código de 6 dígitos ao e-mail do MASTER que pediu, válido por 5 minutos. Use a rota DELETE com o código para excluir.",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.businessDeletionCodeSent,
          400: businessResponses.requestBusinessDeletionErrors,
          404: businessResponses.businessNotFound,
          409: businessResponses.businessHasChildrenConflict,
          500: businessResponses.internalServerError,
          503: authBusyResponse,
        },
      },
    },
    requestBusinessDeletionController.handle,
  );

  app.delete(
    "/delete-business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Confirma a exclusão de uma empresa (com o código)",
        description:
          "Segundo passo da exclusão. Valida o código de 6 dígitos recebido por e-mail e exclui a empresa de vez. Depois, os demais MASTER recebem um aviso de auditoria por e-mail, com a data no fuso da empresa excluída.",
        params: businessSchemas.updateDeleteBusiness,
        body: businessSchemas.confirmDeletionCode,
        response: {
          200: businessResponses.businessDeleted,
          400: businessResponses.confirmBusinessDeletionErrors,
          404: businessResponses.businessNotFound,
          409: businessResponses.businessDeletionConflict,
          500: businessResponses.internalServerError,
          503: authBusyResponse,
        },
      },
    },
    deleteBusinessController.handle,
  );

  app.patch(
    "/toggle-business-active/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["business"],
        summary: "Ativa ou inativa uma empresa",
        description:
          "Ativa ou inativa a empresa. Uma empresa inativa bloqueia o acesso de todos os seus usuários (403 TENANT_INACTIVE).",
        params: businessSchemas.updateDeleteBusiness,
        response: {
          200: businessResponses.businessToggled,
          400: businessResponses.businessParamErrors,
          404: businessResponses.businessNotFoundCodedPath,
          500: businessResponses.internalServerError,
        },
      },
    },
    toggleBusinessActiveController.handle,
  );
}

export { businessRoutes };
