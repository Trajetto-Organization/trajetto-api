import { FastifyInstance } from "fastify";

import { CreateFineController } from "@/modules/fine/usecases/create-fine/create-fine-controller";
import { ListFineController } from "@/modules/fine/usecases/list-fine/list-fine-controller";

import { ExportFineController } from "@/modules/fine/usecases/export-fine/export-fine-controller";

import { UpdateFineController } from "@/modules/fine/usecases/update-fine/update-fine-controller";
import { DeleteFineController } from "@/modules/fine/usecases/delete-fine/delete-fine-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import { fineSchemas, fineResponses } from "./documentation/fine-documentation";
import { panelIdempotencyHeaders } from "./documentation/idempotency-documentation";
import { ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";

const createFineController = new CreateFineController();
const listFineController = new ListFineController();

const exportFineController = new ExportFineController();

const updateFineController = new UpdateFineController();
const deleteFineController = new DeleteFineController();

async function fineRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest), MASTER included, on the
  // company the request names.
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-fine/:businessId",
    {
      // Documentation only; see idempotency-documentation (IDEMP-14).
      config: { openapi: { headers: panelIdempotencyHeaders } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("fine_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Registra uma multa",
        description:
          "Registra uma multa de trânsito para um motorista e um veículo da empresa, com o código de infração da tabela nacional. As datas são dias (`AAAA-MM-DD`) no fuso da empresa, gravados como o instante em que o dia começa nesse fuso: a infração não pode ser futura, o vencimento vem depois da infração e o pagamento (opcional) fica entre a infração e hoje. Sem `points`, valem os pontos do código. Motorista ou veículo inexistentes ou de outra empresa respondem igual: 400 DRIVER_NOT_FOUND ou VEHICLE_NOT_FOUND. Filial inexistente ou de outra empresa também respondem igual: 404 BRANCH_NOT_FOUND (guarda da filial, antes do cadastro); filial desativada: 403. O mesmo `Idempotency-Key` devolve a multa já criada, sem notificar de novo.",
        params: fineSchemas.updateDeleteBusiness,
        body: fineSchemas.createFine,
        response: {
          201: fineResponses.fineCreated,
          400: fineResponses.error.describe(
            "VALIDATION_ERROR, FINE_VIOLATION_DATE_IN_FUTURE, FINE_DUE_DATE_NOT_AFTER_VIOLATION, FINE_PAYMENT_DATE_BEFORE_VIOLATION, FINE_PAYMENT_DATE_IN_FUTURE, BRANCH_NOT_FOUND (MASTER com filial de outra empresa), DRIVER_NOT_FOUND, VEHICLE_NOT_FOUND, TRAFFIC_VIOLATION_CODE_NOT_FOUND, FINE_LOCATION_REQUIRED ou FINE_ORIGINAL_LOCATION_REQUIRED.",
          ),
          403: fineResponses.error.describe(
            "PERMISSION_DENIED, MODULE_NOT_ENABLED, TENANT_INACTIVE, TENANT_ACCESS_DENIED ou filial desativada.",
          ),
          404: fineResponses.error.describe(
            "BRANCH_NOT_FOUND (filial inexistente ou de outra empresa) ou TENANT_NOT_FOUND.",
          ),
          500: fineResponses.error,
        },
      },
    },
    createFineController.handle,
  );

  app.get(
    "/list-fine",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Lista as multas da empresa",
        description:
          "As multas de uma empresa numa tabela paginada, com filial, motorista, veículo e código de infração. Ordena no servidor (`sort`/`order`) e filtra por situação (paga, a vencer, vencida — no dia de negócio da empresa), filial e código, cada filtro com um ou mais valores separados por vírgula, além da busca livre (ID da multa, da filial, do motorista ou do veículo, local, observação, nome ou CPF do motorista, placa ou descrição do veículo, código como `745-50` ou descrição da infração, nome da filial, valor). Cada linha traz as datas também como dias no fuso da empresa (`violation_day`, `due_day`, `payment_day`). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções dos filtros com as contagens. O MASTER informa `businessId`; sem ele, 400 BUSINESS_NOT_IDENTIFIED.",
        querystring: fineSchemas.listFines,
        response: {
          200: ndjsonList(
            fineResponses.fineRow,
            offsetMetaWith(fineResponses.fineListSearchMetaDoc),
          ),
          400: fineResponses.error.describe(
            "VALIDATION_ERROR (ordenação ou filtro inválido) ou BUSINESS_NOT_IDENTIFIED (MASTER sem `businessId`).",
          ),
          403: fineResponses.error,
          500: fineResponses.error,
        },
      },
    },
    listFineController.handle,
  );

  app.get(
    "/export-fine",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Exporta as multas (CSV ou Excel)",
        description:
          "As multas que a listagem mostra com a mesma busca e os mesmos filtros (situação, filial, código), da mais recente para a mais antiga, em `format=csv` (padrão) ou `excel`. Datas e horários no fuso da empresa; o arquivo leva a data do dia de negócio. O MASTER informa `businessId`. Nada a exportar: 400 NO_FINES_TO_EXPORT.",
        querystring: fineSchemas.exportFinesQuery,
        response: {
          200: exportFileResponse("relatorio-multas-<AAAA-MM-DD>"),
          400: fineResponses.error.describe(
            "VALIDATION_ERROR, BUSINESS_NOT_IDENTIFIED (MASTER sem `businessId`) ou NO_FINES_TO_EXPORT.",
          ),
          403: fineResponses.error,
          500: fineResponses.error,
        },
      },
    },
    exportFineController.handle,
  );

  app.patch(
    "/update-fine/:fineId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("fine_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Edita uma multa",
        description:
          "Altera os campos enviados de uma multa. Datas são dias (`AAAA-MM-DD`) no fuso da empresa. As regras de data valem para a multa como ficará salva (infração não futura, vencimento depois da infração, pagamento entre a infração e hoje, no fuso da empresa); `payment_date` vazio desfaz o pagamento. Mover o ponto no mapa registra quem e quando; `latitude`/`longitude` vazios removem o ponto. Multa de outra empresa responde o mesmo 404 de uma que não existe.",
        params: fineSchemas.fineBusinessParams,
        body: fineSchemas.updateFine,
        response: {
          200: fineResponses.fineUpdated,
          400: fineResponses.error.describe(
            "VALIDATION_ERROR, FINE_VIOLATION_DATE_IN_FUTURE, FINE_DUE_DATE_NOT_AFTER_VIOLATION, FINE_PAYMENT_DATE_BEFORE_VIOLATION, FINE_PAYMENT_DATE_IN_FUTURE, BRANCH_NOT_FOUND (MASTER com filial de outra empresa), DRIVER_NOT_FOUND, VEHICLE_NOT_FOUND ou TRAFFIC_VIOLATION_CODE_NOT_FOUND.",
          ),
          403: fineResponses.error.describe(
            "PERMISSION_DENIED, MODULE_NOT_ENABLED, TENANT_INACTIVE, TENANT_ACCESS_DENIED ou filial desativada.",
          ),
          404: fineResponses.error.describe(
            "FINE_NOT_FOUND (multa inexistente ou de outra empresa), BRANCH_NOT_FOUND ou TENANT_NOT_FOUND.",
          ),
          500: fineResponses.error,
        },
      },
    },
    updateFineController.handle,
  );

  app.delete(
    "/delete-fine/:fineId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fine_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        summary: "Exclui uma multa",
        description:
          "Apaga uma multa em definitivo. O `businessId` está na rota, e não por simetria: esta era a única rota de exclusão do produto sem ele, e sem ele `enforceRequestedTenant` não tem o que comparar — qualquer usuário com `fine_manage:write` apagava a multa de qualquer empresa sabendo o id. Multa de outra empresa responde o mesmo 404 de uma que não existe.",
        params: fineSchemas.fineBusinessParams,
        response: {
          200: fineResponses.fineDeleted,
          400: fineResponses.error,
          403: fineResponses.error.describe(
            "PERMISSION_DENIED, MODULE_NOT_ENABLED, TENANT_INACTIVE ou TENANT_ACCESS_DENIED.",
          ),
          404: fineResponses.error.describe(
            "FINE_NOT_FOUND (multa inexistente ou de outra empresa) ou TENANT_NOT_FOUND.",
          ),
          500: fineResponses.error,
        },
      },
    },
    deleteFineController.handle,
  );
}

export { fineRoutes };
