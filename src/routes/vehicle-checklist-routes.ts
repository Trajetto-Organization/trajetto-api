import { FastifyInstance } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { acceptLegacyMultipart } from "@/shared/http/legacy-multipart";
import { ListVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/list-vehicle-checklist-controller";

import { DeleteVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-controller";
import { UpdateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-controller";

import { ExportVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/export-vehicle-checklist/export-vehicle-checklist-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
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
            headers: vehicleChecklistSchemas.idempotencyHeaders,
          },
        },
        onRequest: [ensureAuthenticated],
        preHandler: [
          verifyBusinessActive,
          verifyBranchActive,
          verifyPermission("vehicle_checklist_manage", "write"),
          materializeLegacyUploads,
        ],
        schema: {
          security: [{ bearerAuth: [] }],
          tags: ["vehicle-checklist"],
          summary: "Registra um checklist veicular",
          description:
            "Registra a inspeção de um veículo com motorista, filial e itens. O motorista só inspeciona o veículo que pode operar (o de sua responsabilidade ou o da rota liberada ou em andamento dele). A quilometragem precisa passar a do veículo ou, para um checklist que chega depois de registros mais novos (fila offline do app), caber entre os registros vizinhos da data dele. A data não pode ser posterior ao dia de hoje no fuso da empresa (400 CHECKLIST_DATE_IN_FUTURE); uma data só com dia (AAAA-MM-DD) vale como aquele dia. Um veículo que o motorista não pode operar é recusado com 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER. Um veículo, motorista ou filial de outra empresa recebe a mesma resposta de um inexistente. As fotos são separadas por item e algumas são obrigatórias conforme as respostas; vão em `photos`, as chaves já enviadas ao storage por POST /uploads/presign/:businessId.",
          consumes: ["application/json"],
          params: vehicleChecklistSchemas.businessIdParam,
          response: {
            201: vehicleChecklistResponses.vehicleChecklistCreated,
            400: vehicleChecklistResponses.createVehicleChecklistErrors,
            403: vehicleChecklistResponses.createForbidden,
            404: vehicleChecklistResponses.createNotFound,
            409: vehicleChecklistResponses.writeConflict,
            422: vehicleChecklistResponses.driverInactive,
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
          "Checklists de UMA empresa, paginados: o MASTER informa `businessId`; os demais veem a própria, e o motorista só os dele. Ordena no servidor (`sort`/`order`) e filtra por condição geral, filial e veículo (um ou mais valores separados por vírgula), além da busca livre (ID, observações, veículo, motorista ou filial). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões por condição e as opções dos filtros com as contagens.",
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
          "Atualiza um checklist: itens, observações, data, quilometragem e vínculos (filial, veículo, motorista). Envie só o que mudou. Um vínculo que não muda não é revalidado contra o estado atual: o checklist antigo de um motorista hoje inativo ou de uma filial desativada pode ser corrigido; mover o registro para um motorista inativo (422 DRIVER_INACTIVE) ou para uma filial desativada (409 BRANCH_INACTIVE) é recusado. A quilometragem é posta na data do checklist, com o próprio registro fora da conta: havendo leitura depois dela, fica entre a anterior e a seguinte e a quilometragem do veículo não muda; sendo o checklist mais recente, fica acima da leitura anterior, a quilometragem do veículo avança com ela e, se foi este checklist que a definiu, também desce na correção. Mudar só a data exige que a leitura continue em ordem entre os registros vizinhos da data nova, e a quilometragem do veículo não muda. Fora de ordem: 400 VEHICLE_MILEAGE_OUT_OF_ORDER, com as leituras entre as quais ela precisa ficar. Levar o checklist para outro veículo segue a regra do cadastro nele (400 VEHICLE_MILEAGE_INVALID); se era este checklist que definia a quilometragem do veículo de onde ele sai, ela volta à maior leitura que restou (nunca abaixo da última manutenção). Uma data nova não pode ser posterior ao dia de hoje no fuso da empresa (400 CHECKLIST_DATE_IN_FUTURE); reenviar a data gravada não a confere de novo. Uma data só com dia (AAAA-MM-DD) vale como aquele dia. Motoristas não editam checklists (403 PERMISSION_DENIED). Fotos novas vão em `photos`, as chaves já enviadas ao storage por POST /uploads/presign/:businessId; `photosToRemove` remove fotos do próprio checklist.",
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
