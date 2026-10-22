import { FastifyInstance } from "fastify";
import { container } from "tsyringe";

import { CreateFuelController } from "@/modules/fuel/usecases/create-fuel/create-fuel-controller";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { acceptLegacyMultipart } from "@/shared/http/legacy-multipart";
import { ListFuelController } from "@/modules/fuel/usecases/list-fuel/list-fuel-controller";

import { UpdateFuelController } from "@/modules/fuel/usecases/update-fuel/update-fuel-controller";

import { DeleteFuelController } from "@/modules/fuel/usecases/delete-fuel/delete-fuel-controller";
import { ExportFuelController } from "@/modules/fuel/usecases/export-fuel/export-fuel-controller";

import { GetPreviousFuelController } from "@/modules/fuel/usecases/get-previous-fuel/get-previous-fuel-controller";
import { SearchFuelByVehicleCursorController } from "@/modules/fuel/usecases/search-fuel-by-vehicle-cursor/search-fuel-by-vehicle-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import { fuelSchemas, fuelResponses } from "./documentation/fuel-documentation";
import {
  itemOf,
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { exportFileResponse } from "./documentation/doc-only-responses";
import { errorResponse } from "./documentation/common-responses";

import { listFuelSchema } from "@/schemas/list-fuel-schema";
import { exportFuelQuerySchema } from "@/schemas/export-fuel-schema";
import { fuelListSearchMetaDoc } from "@/modules/fuel/usecases/list-fuel/list-fuel-documentation";

const createFuelController = new CreateFuelController();
const listFuelController = new ListFuelController();

const updateFuelController = new UpdateFuelController();

const deleteFuelController = new DeleteFuelController();
const exportFuelController = new ExportFuelController();

const getPreviousFuelController = new GetPreviousFuelController();
const searchFuelByVehicleCursorController =
  new SearchFuelByVehicleCursorController();

async function fuelRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest). MASTER is checked on
  // every company the request names (decision 4.3).
  requireModuleForPlugin(app, "FLEET");

  // A scope of its own, holding only this route: the app build in drivers'
  // hands still posts a fueling as multipart, and this is the one place that
  // parses it (see shared/http/legacy-multipart.ts, which says when it goes).
  app.register(async (app) => {
    const materializeLegacyUploads = acceptLegacyMultipart(app, {
      shape: "fuel",
      findReplay: (businessId, submissionId, callerDriverId) =>
        container
          .resolve(CreateFuelUseCase)
          .findReplay(businessId, submissionId, callerDriverId),
    });

    app.post(
      "/create-fuel/:businessId",
      {
        config: {
          rateLimit: { max: 60, timeWindow: "1 minute" },
          // Parsed by hand in the controller; see idempotency-documentation.
          openapi: {
            body: fuelSchemas.createFuelBody,
            headers: fuelSchemas.idempotencyHeaders,
          },
        },
        onRequest: [ensureAuthenticated],
        preHandler: [
          verifyBusinessActive,
          verifyBranchActive,
          verifyPermission("fuel_manage", "write"),
          materializeLegacyUploads,
        ],
        schema: {
          security: [{ bearerAuth: [] }],
          tags: ["fuel"],
          summary: "Registra um abastecimento",
          description:
            "Registra um abastecimento de um veículo: filial, motorista, combustível, quilometragem, litros, preço por litro, data e localização. A foto do odômetro é obrigatória e vai em `photo`, a chave já enviada ao storage por POST /uploads/presign/:businessId. O valor total é calculado pelo servidor (litros × preço). A data não pode ser posterior ao dia de hoje no fuso da empresa. A quilometragem é posta na data do abastecimento antes de qualquer mudança no odômetro: havendo registro em dia posterior (abastecimento lançado com atraso, fila offline do app), ela fica entre a leitura anterior e a seguinte e o odômetro do veículo não muda; sendo o registro mais recente (registros do mesmo dia não contam, pois a data do web é o dia, não a hora), ela fica à frente do odômetro, que avança com ela; fora disso, 400 VEHICLE_MILEAGE_INVALID. O motorista abastece só o veículo em que é responsável ou o da sua rota liberada ou em andamento; a filial, o combustível e o motorista dele são preenchidos pelo servidor. Reenvio com a mesma chave de idempotência devolve o registro já criado. Vínculo de outra empresa responde como inexistente.",
          params: fuelSchemas.updateDeleteBusiness,
          consumes: ["application/json"],
          response: {
            201: fuelResponses.fuelCreated,
            400: fuelResponses.createFuelErrors,
            403: fuelResponses.writeForbidden,
            404: fuelResponses.createNotFound,
            409: fuelResponses.writeConflict,
            422: fuelResponses.driverInactive,
            500: fuelResponses.internalServerError,
          },
        },
      },
      createFuelController.handle,
    );
  });

  app.get(
    "/list-fuel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Lista os abastecimentos da empresa",
        description:
          "Abastecimentos de uma empresa numa tabela paginada, com veículo, motorista, filial, combustível e a foto do odômetro em URL assinada. Ordena no servidor (`sort`/`order`) e filtra por filial, veículo e tipo de combustível (um ou mais IDs separados por vírgula), além da busca livre (ID, observações, placa, descrição/marca/modelo do veículo, motorista, CNH, combustível e filial). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (total, litros, valor e odômetros verificados) somados sobre todo o conjunto filtrado e as opções dos filtros com as contagens (até 100 por filtro, as de mais abastecimentos; as selecionadas sempre vêm — a busca alcança as demais). Ordenação padrão: mais novos primeiro, com desempate pelo ID. O MASTER informa `businessId`; os demais veem a própria empresa. O motorista vê só os próprios abastecimentos.",
        querystring: listFuelSchema,
        response: {
          200: ndjsonList(
            itemOf(fuelResponses.fuelList),
            offsetMetaWith(fuelListSearchMetaDoc),
          ),
          400: errorResponse.describe(
            "VALIDATION_ERROR (parâmetros inválidos, ordenação que o servidor não oferece, ID malformado num filtro), BUSINESS_NOT_IDENTIFIED (o MASTER não informou a empresa) ou USER_NOT_FOUND.",
          ),
          403: errorResponse,
          500: fuelResponses.internalServerError,
        },
      },
    },
    listFuelController.handle,
  );

  app.patch(
    "/update-fuel/:fuelId/business/:businessId",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        openapi: { body: fuelSchemas.updateFuelBody },
      },
      onRequest: [ensureAuthenticated],
      // No verifyBranchActive here: it refused any edit that resent the
      // record's own branch once that branch was deactivated. The use case
      // checks the branch only when the edit moves the record (FLEET-FUEL-1).
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fuel_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Atualiza um abastecimento",
        description:
          "Atualiza um abastecimento: quilometragem, litros, preço, data, observações, localização e vínculos (filial, veículo, motorista, combustível). Envie só o que mudou. Um vínculo que não muda não é revalidado contra o estado atual: o abastecimento antigo de um veículo hoje inativo ou bloqueado, ou de um motorista inativo, pode ter o preço corrigido; mover o registro para um veículo que não está ativo/em rota, um motorista inativo ou uma filial inativa é recusado. A data não pode ser posterior ao dia de hoje no fuso da empresa. A quilometragem é posta na data do abastecimento (a nova, quando a data muda; mudar só a data também é conferido), com o próprio registro fora da conta: havendo registro em dia posterior, fica entre a leitura anterior e a seguinte e o odômetro do veículo não muda; sendo o abastecimento mais recente, fica acima da leitura anterior e o odômetro avança com ela. Se foi este abastecimento que definiu o odômetro, a correção o leva à maior leitura restante (esta incluída), nunca abaixo da última manutenção. Fora disso, 400 VEHICLE_MILEAGE_INVALID. Mover o registro para outro veículo segue lá a regra do cadastro, e o veículo que ele deixa volta à maior leitura restante se era este abastecimento que definia o odômetro dele. A nova foto do odômetro é opcional e vai em `photo`, a chave já enviada ao storage por POST /uploads/presign/:businessId.",
        params: fuelSchemas.updateDeleteFuel,
        consumes: ["application/json"],
        response: {
          200: fuelResponses.fuelUpdated,
          400: fuelResponses.updateFuelErrors,
          403: fuelResponses.writeForbidden,
          404: fuelResponses.updateNotFound,
          409: fuelResponses.branchInactive,
          422: fuelResponses.driverInactive,
          500: fuelResponses.internalServerError,
        },
      },
    },
    updateFuelController.handle,
  );

  app.delete(
    "/delete-fuel/:fuelId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // A deactivated company is read-only (TENANT_INACTIVE), as on every
      // other write of this plugin; the delete was the one without it.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("fuel_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Exclui um abastecimento",
        description:
          "Exclui o abastecimento definitivamente, com a foto do odômetro, e registra a exclusão nas atividades. Se era este abastecimento que definia o odômetro do veículo, o odômetro volta à maior leitura restante (abastecimentos e checklists), nunca abaixo da última manutenção; sem leitura restante, fica como está. Motoristas não excluem (403 DRIVER_CANNOT_DELETE_FUEL). Um abastecimento de outra empresa responde como inexistente (404 FUEL_NOT_FOUND).",
        params: fuelSchemas.updateDeleteFuel,
        response: {
          200: fuelResponses.fuelDeleted,
          400: errorResponse,
          403: fuelResponses.writeForbidden,
          404: fuelResponses.fuelNotFound,
          500: fuelResponses.internalServerError,
        },
      },
    },
    deleteFuelController.handle,
  );

  app.get(
    "/export-fuel",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      // Drivers hold fuel WRITE for their own refuelings; an export is the
      // back office reading the whole company. Refused by the guard with
      // PERMISSION_DENIED (decision 4.1).
      preHandler: [
        verifyPermission("fuel_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Exporta os abastecimentos (CSV ou Excel)",
        description:
          "Exporta os abastecimentos em CSV ou Excel (`format=csv|excel`) com a mesma busca e os mesmos filtros da listagem (`search`, `branchId`, `vehicleId`, `fuelTypeId`): o arquivo traz o que a tela filtrou. O MASTER informa `businessId`. O nome do arquivo usa o dia de hoje no fuso da empresa. Motoristas não exportam.",
        querystring: exportFuelQuerySchema,
        response: {
          200: exportFileResponse("relatorio-abastecimentos-<AAAA-MM-DD>"),
          400: fuelResponses.exportFuelErrors,
          403: errorResponse.describe(
            "PERMISSION_DENIED (inclusive motoristas, que não exportam), MODULE_NOT_ENABLED, TENANT_INACTIVE ou TENANT_ACCESS_DENIED.",
          ),
          500: fuelResponses.internalServerError,
        },
      },
    },
    exportFuelController.handle,
  );

  app.get(
    "/get-previous-fuel/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Abastecimento anterior de um veículo",
        description:
          "O último abastecimento do veículo antes da data informada, só com data, quilometragem e litros (a base do consumo no detalhe), ou `null` quando não há. `businessId` é a empresa do veículo; só o MASTER informa outra empresa que não a sua. Um veículo de outra empresa responde como inexistente (404 VEHICLE_NOT_FOUND). O motorista consulta só o veículo que pode operar: aquele em que é o responsável ou o da sua rota liberada ou em andamento; outro veículo da empresa recebe 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER.",
        params: fuelSchemas.getPreviousFuelParams,
        querystring: fuelSchemas.getPreviousFuelQuery,
        response: {
          200: fuelResponses.previousFuelReading,
          400: fuelResponses.vehicleReadErrors,
          403: fuelResponses.vehicleReadForbidden,
          404: fuelResponses.vehicleNotFound,
          500: fuelResponses.internalServerError,
        },
      },
    },
    getPreviousFuelController.handle,
  );

  app.get(
    "/search-fuel-by-vehicle/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        summary: "Abastecimentos de um veículo (cursor)",
        description:
          "Abastecimentos de um veículo em NDJSON paginado por cursor, do mais recente ao mais antigo. " +
          "A primeira linha traz `{meta: {searchMeta: {nextCursor, hasMore}}}`; as seguintes, um abastecimento cada. " +
          "Envie `nextCursor` como `cursor` para a próxima página. `search` filtra como a busca da listagem (até 100 caracteres). " +
          "Só veículos da empresa de quem pede: outro veículo responde como inexistente (404 VEHICLE_NOT_FOUND). O motorista consulta o veículo que pode operar — aquele em que é o responsável ou o da sua rota liberada ou em andamento; outro veículo da empresa recebe 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER — e vê só os próprios abastecimentos dele, nunca os dos colegas.",
        params: fuelSchemas.searchFuelByVehicleParams,
        querystring: fuelSchemas.searchFuelByVehicleCursor,
        response: {
          200: ndjsonCursor(itemOf(fuelResponses.fuelList)),
          400: fuelResponses.vehicleReadErrors,
          403: fuelResponses.vehicleReadForbidden,
          404: fuelResponses.vehicleNotFound,
          500: fuelResponses.internalServerError,
        },
      },
    },
    searchFuelByVehicleCursorController.handle,
  );
}

export { fuelRoutes };
