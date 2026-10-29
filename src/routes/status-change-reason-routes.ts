import { FastifyInstance } from "fastify";

import { CreateStatusChangeReasonController } from "@/modules/status-change-reason/usecases/create-status-change-reason/create-status-change-reason-controller";
import { ListStatusChangeReasonController } from "@/modules/status-change-reason/usecases/list-status-change-reason/list-status-change-reason-controller";

import { UpdateStatusChangeReasonController } from "@/modules/status-change-reason/usecases/update-status-change-reason/update-status-change-reason-controller";
import { DeleteStatusChangeReasonController } from "@/modules/status-change-reason/usecases/delete-status-change-reason/delete-status-change-reason-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  statusChangeReasonSchemas,
  statusChangeReasonResponses,
} from "./documentation/status-change-reason-documentation";
import { ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { statusReasonListSearchMetaDoc } from "@/modules/status-change-reason/usecases/list-status-change-reason/list-status-change-reason-documentation";

const createStatusChangeReasonController =
  new CreateStatusChangeReasonController();
const listStatusChangeReasonController = new ListStatusChangeReasonController();

const updateStatusChangeReasonController =
  new UpdateStatusChangeReasonController();
const deleteStatusChangeReasonController =
  new DeleteStatusChangeReasonController();

/**
 * The company's vocabulary for overriding a delivery's status.
 *
 * Behind `delivery_manage` and the DELIVERIES module, like the deliveries it
 * explains: this catalogue exists only to answer a question about a delivery,
 * and a company without the module has no delivery to answer about.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function statusChangeReasonRoutes(app: FastifyInstance) {
  app.post(
    "/create-status-change-reason/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["status-change-reason"],
        summary: "Cria um motivo de mudança de status",
        description:
          "As palavras que a empresa usa para explicar por que o status de uma entrega foi mudado à mão. Curto de propósito: aparece num seletor e numa linha do histórico; o detalhe vai na anotação digitada na hora. Nome único na empresa (409 STATUS_CHANGE_REASON_NAME_TAKEN). Emite `catalogChanged` (status_reason).",
        params: statusChangeReasonSchemas.businessIdParam,
        body: statusChangeReasonSchemas.createStatusChangeReason,
        response: {
          201: statusChangeReasonResponses.reasonCreated,
          400: statusChangeReasonResponses.codedError,
          403: statusChangeReasonResponses.codedError,
          404: statusChangeReasonResponses.lookupNotFound,
          409: statusChangeReasonResponses.codedError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    createStatusChangeReasonController.handle,
  );

  app.get(
    "/list-status-change-reason",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        // The override catalogue is the panel's; drivers never move a
        // status by hand (decision 4.4).
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["status-change-reason"],
        summary: "Lista os motivos de mudança de status",
        description:
          "Token de motorista recebe 403 PERMISSION_DENIED (o motorista não muda status à mão). Tabela paginada no servidor: ordena por `sort`/`order` (name, created_at, updated_at) e filtra por `status` (active, inactive), além da busca por id, nome ou descrição. Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` (total do filtro; cartões com a busca, sem o filtro de status; opções do filtro com as contagens) e cada linha seguinte é um motivo. Chamar response.json() nisso dá erro de parse — leia linha a linha. `searchMeta.used` conta quantos motivos já explicam alguma mudança no histórico, que é o que separa o vocabulário real do que foi digitado uma vez e esquecido.",
        querystring: statusChangeReasonSchemas.listStatusChangeReasons,
        response: {
          200: ndjsonList(
            statusChangeReasonResponses.reasonListRow,
            offsetMetaWith(statusReasonListSearchMetaDoc),
          ),
          400: statusChangeReasonResponses.codedError,
          403: statusChangeReasonResponses.codedError,
          404: statusChangeReasonResponses.lookupNotFound,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    listStatusChangeReasonController.handle,
  );

  app.patch(
    "/update-status-change-reason/:reasonId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["status-change-reason"],
        summary: "Edita ou desativa um motivo",
        description:
          "`is_active: false` desativa o motivo: ele continua explicando os eventos que já o citam e deixa de ser oferecido para novas mudanças. Excluir um motivo já usado é recusado. Motivo inexistente ou de outra empresa → 404 STATUS_CHANGE_REASON_NOT_FOUND (a mesma resposta nos dois casos); nome de outro motivo da empresa → 409 STATUS_CHANGE_REASON_NAME_TAKEN. Emite `catalogChanged` (status_reason).",
        params: statusChangeReasonSchemas.reasonBusinessParams,
        body: statusChangeReasonSchemas.updateStatusChangeReason,
        response: {
          200: statusChangeReasonResponses.reasonUpdated,
          400: statusChangeReasonResponses.codedError,
          403: statusChangeReasonResponses.codedError,
          404: statusChangeReasonResponses.reasonNotFound,
          409: statusChangeReasonResponses.codedError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    updateStatusChangeReasonController.handle,
  );

  app.delete(
    "/delete-status-change-reason/:reasonId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["status-change-reason"],
        summary: "Exclui um motivo nunca usado",
        description:
          "Só um motivo que nenhum evento cita. Um motivo já usado responde 409 STATUS_CHANGE_REASON_IN_USE com quantos eventos dependem dele e sugere desativá-lo. Motivo inexistente ou de outra empresa → 404 STATUS_CHANGE_REASON_NOT_FOUND. Emite `catalogChanged` (status_reason).",
        params: statusChangeReasonSchemas.reasonBusinessParams,
        response: {
          200: statusChangeReasonResponses.reasonDeleted,
          400: statusChangeReasonResponses.codedError,
          403: statusChangeReasonResponses.codedError,
          404: statusChangeReasonResponses.reasonNotFound,
          409: statusChangeReasonResponses.codedError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    deleteStatusChangeReasonController.handle,
  );
}

export { statusChangeReasonRoutes };
