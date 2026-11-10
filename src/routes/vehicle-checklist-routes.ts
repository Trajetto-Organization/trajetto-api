import { FastifyInstance } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { acceptLegacyMultipart } from "@/shared/http/legacy-multipart";
import { clientSentAtHeaders } from "@/shared/delivery/occurred-at";
import { clientVersionHeaders } from "@/shared/http/client-version";
import { ListVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/list-vehicle-checklist-controller";

import { DeleteVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-controller";
import { UpdateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-controller";

import { ExportVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/export-vehicle-checklist/export-vehicle-checklist-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  ignoreDriverBranchChoice,
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import {
  vehicleChecklistSchemas,
  vehicleChecklistResponses,
  vehicleChecklistSearchMetaDoc,
} from "./documentation/vehicle-checklist-documentation";
import { itemOf, ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";

const createVehicleChecklistController = new CreateVehicleChecklistController();
const listVehicleChecklistController = new ListVehicleChecklistController();

const deleteVehicleChecklistController = new DeleteVehicleChecklistController();
const updateVehicleChecklistController = new UpdateVehicleChecklistController();

const exportVehicleChecklistController = new ExportVehicleChecklistController();

async function vehicleChecklistRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest). MASTER is checked on
  // every company the request names (decision 4.3).
  requireModuleForPlugin(app, "FLEET");

  // A scope of its own, holding only this route: the app build in drivers'
  // hands still posts a checklist as multipart, and this is the one place
  // that parses it (see shared/http/legacy-multipart.ts, which says when it
  // goes).
  app.register(async (app) => {
    const materializeLegacyUploads = acceptLegacyMultipart(app, {
      shape: "checklist",
      findReplay: (businessId, submissionId, callerDriverId) =>
        container
          .resolve(CreateVehicleChecklistUseCase)
          .findReplay(businessId, submissionId, callerDriverId),
    });

    app.post(
      "/create-vehicle-checklist/:businessId",
      {
        config: {
          rateLimit: { max: 30, timeWindow: "1 minute" },
          // Parsed by hand in the controller; see idempotency-documentation.
          openapi: {
            body: vehicleChecklistSchemas.createVehicleChecklistBody,
            // X-Client-Sent-At dates a checklist queued offline (K6); the
            // build's contract decides an early arrival (refused or flagged).
            headers: vehicleChecklistSchemas.idempotencyHeaders
              .merge(clientSentAtHeaders)
              .merge(clientVersionHeaders),
          },
        },
        onRequest: [ensureAuthenticated],
        preHandler: [
          verifyBusinessActive,
          // A driver's branch is the server's to resolve (wave 3.7).
          ignoreDriverBranchChoice,
          verifyBranchActive,
          verifyPermission("vehicle_checklist_manage", "write"),
          materializeLegacyUploads,
        ],
        schema: {
          security: [{ bearerAuth: [] }],
          tags: ["vehicle-checklist"],
          summary: "Registra um checklist veicular",
          description:
            "Registra a inspeção de um veículo com motorista, filial e itens. O motorista só inspeciona o veículo que pode operar (o de sua responsabilidade ou o da rota liberada ou em andamento dele). A quilometragem precisa passar a do veículo ou, para um checklist que chega depois de registros mais novos (fila offline do app), caber entre os registros vizinhos da data dele. Também vale repetir a leitura do registro vizinho (o anterior ou o seguinte, abastecimento ou checklist) quando ele é de menos de 30 minutos antes ou depois, como o checklist de chegada logo depois de abastecer, desde que nenhuma das duas datas seja só o dia; aí a quilometragem do veículo não muda e, como o registro mais recente, ele não pode ficar abaixo dela (uma ordem de serviço ou um MASTER pode tê-la subido depois do registro repetido). Fora disso, 400 VEHICLE_MILEAGE_INVALID. A data não pode ser posterior ao dia de hoje no fuso da empresa (400 CHECKLIST_DATE_IN_FUTURE); uma data só com dia (AAAA-MM-DD) vale como aquele dia. Um veículo que o motorista não pode operar é recusado com 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER. Um veículo, motorista ou filial de outra empresa recebe a mesma resposta de um inexistente. As fotos são separadas por item e algumas são obrigatórias conforme as respostas; vão em `photos`, as chaves já enviadas ao storage por POST /uploads/presign/:businessId. Checklist da rota (plano de 02/11/2026, C4/F3): `routeId` com `phase` ROUTE_START (saída) ou ROUTE_END (chegada); a rota tem de ser do motorista do checklist e ter o veículo dele (422 ROUTE_LINK_MISMATCH; rota inexistente ou de outra empresa, 404 DELIVERY_ROUTE_NOT_FOUND), em qualquer status, porque um checklist feito sem sinal pode chegar depois do início. A exceção é o checklist de chegada do motorista: só com a rota iniciada (ou já encerrada) e todas as paradas resolvidas (concluída, com insucesso ou cancelada), em qualquer ordem e contando as incluídas com a rota em andamento; antes disso, 409 CHECKLIST_ARRIVAL_ROUTE_OPEN com `open_stops` para o app que envia `contract` 5 ou maior em `x-trajetto-client-version`, enquanto o de versão anterior, ou sem o cabeçalho, tem o checklist gravado e marcado na atividade com as paradas em aberto. Para o mesmo app, o checklist de chegada também precisa ser datado depois da última entrega da rota: uma parada concluída ou com insucesso mais de 5 minutos depois da data dele (o checklist salvo sem sinal antes de o despachante incluir uma parada, ou o rascunho de antes dela) recebe 409 CHECKLIST_ARRIVAL_BEFORE_ROUTE_END, definitivo; faça um novo. Para o motorista, a rota também prova que o veículo estava com ele, mas só num checklist datado do dia da liberação da rota até 24 h depois do fim dela (concluída ou cancelada); uma rota planejada, nunca liberada ou de outra época não prova nada, e vale a regra do veículo (403 VEHICLE_NOT_ASSIGNED_TO_DRIVER). A filial do motorista é preenchida pelo servidor (a enviada no corpo é ignorada) e é sempre uma filial ATIVA: a do veículo, senão a dele, senão a única filial ativa da empresa, pulando as desativadas (uma filial desativada depois da liberação não prende o checklist); sem nenhuma, 409 BRANCH_REQUIRED e, com `routeId`, quem opera as entregas é avisado uma vez por rota e momento (`route.record_branch_missing`). Feito sem sinal (K6): `occurred_at` (o momento do checklist, pelo relógio do aparelho) com o header X-Client-Sent-At substitui `checklist_date`, corrigido pelo erro do relógio do aparelho. A origem (`created_from`) do checklist do motorista é sempre MOBILE_APP, decidida pelo servidor seja qual for o valor enviado; para os demais vale a enviada e, quando ausente, MOBILE_APP se o envio traz a chave de idempotência (no corpo ou no header Idempotency-Key), que só o app manda, e WEB_DASHBOARD se não traz.",
          consumes: ["application/json"],
          params: vehicleChecklistSchemas.businessIdParam,
          response: {
            201: vehicleChecklistResponses.vehicleChecklistCreated,
            400: vehicleChecklistResponses.createVehicleChecklistErrors,
            403: vehicleChecklistResponses.createForbidden,
            404: vehicleChecklistResponses.createNotFound,
            409: vehicleChecklistResponses.writeConflict,
            422: vehicleChecklistResponses.createUnprocessable,
            500: vehicleChecklistResponses.internalServerError,
          },
        },
      },
      createVehicleChecklistController.handle,
    );
  });

  app.get(
    "/list-vehicle-checklist",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_checklist_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Lista os checklists da empresa",
        description:
          "Checklists de UMA empresa, paginados: o MASTER informa `businessId`; os demais veem a própria, e o motorista só os dele. Ordena no servidor (`sort`/`order`) e filtra por condição geral, filial e veículo (um ou mais valores separados por vírgula), além da busca livre (ID, observações, veículo, motorista ou filial). O ID vale inteiro ou só o final que a tabela mostra (pelo menos 8 caracteres hexadecimais). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões por condição e as opções dos filtros com as contagens.",
        querystring: vehicleChecklistSchemas.listVehicleChecklist,
        response: {
          200: ndjsonList(
            itemOf(vehicleChecklistResponses.vehicleChecklistList),
            offsetMetaWith(vehicleChecklistSearchMetaDoc),
          ),
          400: vehicleChecklistResponses.listVehicleChecklistErrors,
          404: vehicleChecklistResponses.resourceNotFound,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    listVehicleChecklistController.handle,
  );

  app.patch(
    "/update-vehicle-checklist/:checklistId/business/:businessId",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
        openapi: { body: vehicleChecklistSchemas.updateVehicleChecklistBody },
      },
      onRequest: [ensureAuthenticated],
      // No verifyBranchActive here: it refused any edit that resent the
      // checklist's own branch once that branch was closed. The use case
      // checks the branch only when the edit moves the record (FLEET-FUEL-1).
      // Drivers hold the write grant to SEND checklists from the app; editing
      // one is the office's, refused as a permission (decision 4.1).
      preHandler: [
        verifyBusinessActive,
        verifyPermission("vehicle_checklist_manage", "write", {
          allowDriver: false,
        }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Atualiza um checklist veicular",
        description:
          "Atualiza um checklist: itens, observações, data, quilometragem e vínculos (filial, veículo, motorista). Envie só o que mudou. Um vínculo que não muda não é revalidado contra o estado atual: o checklist antigo de um motorista hoje inativo ou de uma filial desativada pode ser corrigido; mover o registro para um motorista inativo (422 DRIVER_INACTIVE) ou para uma filial desativada (409 BRANCH_INACTIVE) é recusado. A quilometragem é posta na data do checklist, com o próprio registro fora da conta: havendo leitura depois dela, fica entre a anterior e a seguinte e a quilometragem do veículo não muda; sendo o checklist mais recente, fica acima da leitura anterior, a quilometragem do veículo avança com ela e, se foi este checklist que a definiu, também desce na correção. Mudar só a data exige que a leitura continue em ordem entre os registros vizinhos da data nova, e a quilometragem do veículo não muda. Igual à leitura vizinha (a anterior ou a seguinte) também vale quando o registro dela é de menos de 30 minutos antes ou depois e nenhuma das duas datas é só o dia: a quilometragem do veículo não avança por isso e, se foi este checklist que a definiu, desce até a maior leitura restante. Fora de ordem: 400 VEHICLE_MILEAGE_OUT_OF_ORDER, com as leituras entre as quais ela precisa ficar e a que pode repetir. Levar o checklist para outro veículo segue a regra do cadastro nele (400 VEHICLE_MILEAGE_INVALID); se era este checklist que definia a quilometragem do veículo de onde ele sai, ela volta à maior leitura que restou (nunca abaixo da última manutenção). Uma data nova não pode ser posterior ao dia de hoje no fuso da empresa (400 CHECKLIST_DATE_IN_FUTURE); reenviar a data gravada não a confere de novo. Uma data só com dia (AAAA-MM-DD) vale como aquele dia. Motoristas não editam checklists (403 PERMISSION_DENIED). Fotos novas vão em `photos`, as chaves já enviadas ao storage por POST /uploads/presign/:businessId; `photosToRemove` remove fotos do próprio checklist.",
        consumes: ["application/json"],
        params: vehicleChecklistSchemas.updateDeleteVehicleChecklist,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistUpdated,
          400: vehicleChecklistResponses.updateVehicleChecklistErrors,
          403: vehicleChecklistResponses.editForbidden,
          404: vehicleChecklistResponses.vehicleChecklistNotFound,
          409: vehicleChecklistResponses.branchInactive,
          422: vehicleChecklistResponses.driverInactive,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    updateVehicleChecklistController.handle,
  );

  app.delete(
    "/delete-vehicle-checklist/:checklistId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Same as the edit: the driver's grant is for sending, not deleting.
      preHandler: [
        verifyPermission("vehicle_checklist_manage", "write", {
          allowDriver: false,
        }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Exclui um checklist veicular",
        description:
          "Exclui o checklist da empresa e as fotos dele. Se era este checklist que definia a quilometragem do veículo, ela volta à maior leitura que restou nos abastecimentos e checklists (nunca abaixo da última manutenção); sem leitura restante, fica como está. Um checklist de outra empresa responde como inexistente (404 VEHICLE_CHECKLIST_NOT_FOUND). Motoristas não excluem checklists (403 PERMISSION_DENIED).",
        params: vehicleChecklistSchemas.updateDeleteVehicleChecklist,
        response: {
          200: vehicleChecklistResponses.vehicleChecklistDeleted,
          400: vehicleChecklistResponses.deleteValidationError,
          403: vehicleChecklistResponses.editForbidden,
          404: vehicleChecklistResponses.vehicleChecklistNotFound,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    deleteVehicleChecklistController.handle,
  );

  app.get(
    "/export-vehicle-checklist",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      // Drivers hold checklist WRITE for their own inspections; an export is
      // the back office reading the whole company. Refused by the guard with
      // PERMISSION_DENIED (decision 4.1), like the fuel export.
      preHandler: [
        verifyPermission("vehicle_checklist_manage", "write", {
          allowDriver: false,
        }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-checklist"],
        summary: "Exporta os checklists (CSV ou Excel)",
        description:
          "Exporta a mesma lista da tela: a mesma busca e os mesmos filtros de condição, filial e veículo, da empresa escolhida (`businessId`, só o MASTER) ou da própria. Motoristas não exportam (403 PERMISSION_DENIED). `format=csv|excel`.",
        querystring: vehicleChecklistSchemas.exportVehicleChecklistsQuery,
        response: {
          200: exportFileResponse(
            "relatorio-checklists-veiculares-<AAAA-MM-DD>",
          ),
          400: vehicleChecklistResponses.exportVehicleChecklistErrors,
          403: vehicleChecklistResponses.exportForbidden,
          404: vehicleChecklistResponses.exportBusinessNotFound,
          500: vehicleChecklistResponses.internalServerError,
        },
      },
    },
    exportVehicleChecklistController.handle,
  );
}

export { vehicleChecklistRoutes };
