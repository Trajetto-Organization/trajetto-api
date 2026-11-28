import { z } from "zod";
import { responseDate } from "./response-date";

import {
  exportVehicleChecklistSchema,
  listVehicleChecklistSchema,
} from "@/schemas/list-vehicle-checklist-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { errorResponse } from "./common-responses";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";
import { updateVehicleChecklistSchema } from "@/schemas/update-vehicle-checklist-schema";

import { presignedPhotosSchema } from "@/schemas/presigned-photos-schema";
import { idempotencyHeaders } from "./idempotency-documentation";

/**
 * A checklist refusal: the common error body plus what the photo checks add.
 * One object instead of a union of messages: the serializer keeps the first
 * union member that fits, and `{ message }` fitted every body, so `code`,
 * `missingPhotos` and the rest were dropped from the answer.
 */
const checklistRefusal = errorResponse.extend({
  details: z
    .string()
    .optional()
    .describe("VALIDATION_ERROR: o que o schema recusou."),
  errors: z
    .array(z.string())
    .optional()
    .describe("PHOTOS_REQUIRED: uma frase por item sem foto."),
  missingPhotos: z
    .array(z.string())
    .optional()
    .describe("PHOTOS_REQUIRED: os itens (`fieldName`) que precisam de foto."),
  photoRequirements: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "PHOTOS_REQUIRED: a regra de foto de cada item, conforme as respostas.",
    ),
  fieldsSent: z.array(z.string()).optional(),
  photosSent: z.array(z.string()).optional(),
  existingPhotos: z.array(z.string()).optional(),
  photosToRemove: z.array(z.string()).optional(),
});

const vehicleChecklistSchemas = {
  createVehicleChecklist: createVehicleChecklistSchema,
  updateVehicleChecklist: updateVehicleChecklistSchema,

  // What the app really POSTs: the form fields the controller validates with
  // the checklist schema, plus the keys of the photos it already uploaded.
  // Documentation only (see routes/documentation/openapi-transform).
  createVehicleChecklistBody: z
    .object({
      photos: presignedPhotosSchema.describe(
        "Fotos já enviadas ao storage (POST /uploads/presign/:businessId), cada uma com o `fieldName` do item que documenta. Alguns itens exigem foto conforme a resposta.",
      ),
    })
    .and(createVehicleChecklistSchema),
  updateVehicleChecklistBody: z
    .object({
      photos: presignedPhotosSchema.describe(
        "Fotos novas, mesma regra do cadastro.",
      ),
    })
    .and(updateVehicleChecklistSchema),
  idempotencyHeaders,
  listVehicleChecklist: listVehicleChecklistSchema,
  updateDeleteVehicleChecklist: z.object({
    checklistId: z.string().uuid(),
    businessId: z.string().uuid(),
  }),
  updateDeleteBusiness: updateDeleteBusinessSchema,
  businessIdParam: updateDeleteBusinessSchema,
  exportVehicleChecklistsQuery: exportVehicleChecklistSchema,
};

const vehicleChecklistResponses = {
  vehicleChecklistCreated: z.object({
    message: z.string().default("Checklist veicular criado com sucesso!"),
    // The controller sends it; a schema without it stripped it on the way out.
    id: z.string().describe("Id do checklist criado."),
  }),
  vehicleChecklistUpdated: z.object({
    message: z.string().default("Checklist veicular atualizado com sucesso!"),
  }),
  vehicleChecklistDeleted: z.object({
    message: z.string().default("Checklist veicular excluído com sucesso!"),
  }),
  vehicleChecklistList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Vehicle checklist record ID"),
        current_mileage: z.number().describe("Current vehicle mileage"),
        checklist_date: z
          .union([responseDate(), z.string()])
          .describe("Date of checklist inspection (RAW: Date or ISO string)"),
        tires_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of tires"),
        headlights_working: z
          .boolean()
          .describe("Whether headlights are working"),
        taillights_working: z
          .boolean()
          .describe("Whether taillights are working"),
        turn_signals_working: z
          .boolean()
          .describe("Whether turn signals are working"),
        bumpers_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of bumpers"),
        windshield_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of windshield"),
        mirrors_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of mirrors"),
        seatbelts_working: z
          .boolean()
          .describe("Whether seatbelts are working"),
        dashboard_working: z.boolean().describe("Whether dashboard is working"),
        steering_wheel_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of steering wheel"),
        brakes_working: z.boolean().describe("Whether brakes are working"),
        clutch_working: z.boolean().describe("Whether clutch is working"),
        fuel_level_adequate: z
          .boolean()
          .describe("Whether fuel level is adequate"),
        oil_level_adequate: z
          .boolean()
          .describe("Whether oil level is adequate"),
        radiator_water_adequate: z
          .boolean()
          .describe("Whether radiator water is adequate"),
        brake_fluid_adequate: z
          .boolean()
          .describe("Whether brake fluid is adequate"),
        battery_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of battery"),
        driver_license_valid: z
          .boolean()
          .describe("Whether driver license is valid"),
        vehicle_documents_valid: z
          .boolean()
          .describe("Whether vehicle documents are valid"),
        insurance_valid: z.boolean().describe("Whether insurance is valid"),
        fire_extinguisher_valid: z
          .boolean()
          .describe("Whether fire extinguisher is valid"),
        warning_triangle_present: z
          .boolean()
          .describe("Whether warning triangle is present"),
        jack_present: z.boolean().describe("Whether jack is present"),
        spare_tire_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Condition of spare tire"),
        notes: z.string().nullable().describe("Additional notes"),
        photos: z.array(z.string()).describe("Array of photo URLs"),
        overall_condition: z
          .enum(["good", "fair", "poor"])
          .describe("Overall vehicle condition"),
        businessId: z.string().describe("Business ID"),
        branchId: z.string().describe("Branch ID"),
        vehicleId: z.string().describe("Vehicle ID"),
        driverId: z.string().describe("Driver ID"),
        // Contract C3 (03/11/2026).
        routeId: z
          .string()
          .nullable()
          .describe(
            "Rota para a qual o checklist foi feito (plano de 02/11/2026, C4/F3); null fora de rota.",
          ),
        route: z
          .object({
            id: z.string().describe("ID da rota."),
            code: z
              .string()
              .describe(
                'Número da rota, como texto (ex.: "318"): o "Rota 318" das telas.',
              ),
          })
          .nullable()
          .describe(
            "A rota do checklist, para o link da linha. Só uma rota desta empresa é nomeada: null fora de rota (e para uma rota que não seja da empresa do registro).",
          ),
        phase: z
          .enum(["ROUTE_START", "ROUTE_END"])
          .nullable()
          .describe(
            "O momento da rota: ROUTE_START (saída) ou ROUTE_END (chegada); null para o checklist feito fora de uma rota.",
          ),
        created_from: z
          .enum(["MOBILE_APP", "WEB_DASHBOARD"])
          .describe(
            "Origem do registro: MOBILE_APP (app do motorista) ou WEB_DASHBOARD (painel). O checklist de um motorista é sempre MOBILE_APP, decidido pelo servidor.",
          ),
        business: z
          .object({
            corporate_reason: z.string(),
            fantasy_name: z.string().nullable(),
          })
          .optional()
          .describe("Business nested object (only for MASTER role)"),
        branch: z
          .object({
            corporate_reason: z.string(),
            fantasy_name: z.string().nullable(),
          })
          .describe("Branch nested object"),
        vehicle: z
          .object({
            description: z.string(),
            license_plate: z.string(),
            brand: z.string(),
            model: z.string(),
            current_mileage: z.number(),
          })
          .describe("Vehicle nested object"),
        driver: z
          .object({
            name: z.string(),
            cnh: z.string(),
          })
          .describe("Driver nested object"),
        created_at: z
          .union([responseDate(), z.string()])
          .describe("Creation date (RAW: Date or ISO string)"),
        updated_at: z
          .union([responseDate(), z.string()])
          .describe("Last update date (RAW: Date or ISO string)"),
      }),
    ),
    total: z.number().describe("Total number of records"),
  }),
  // Every refusal below carries `code` (decision 11.3), also in the
  // `x-error-code` header. The schema keeps it: a narrower one stripped the
  // code from the body of the controllers' own answers.
  resourceNotFound: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  vehicleChecklistNotFound: errorResponse.describe(
    "VEHICLE_CHECKLIST_NOT_FOUND: o checklist não existe nesta empresa. Um checklist de outra empresa recebe exatamente a mesma resposta. BUSINESS_NOT_FOUND: a empresa informada não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  // The use case's 404s; the route guards add theirs (TENANT_NOT_FOUND for
  // the company in the path, BRANCH_NOT_FOUND for the branch in the body) to
  // the same status in the published document.
  createNotFound: errorResponse.describe(
    "BRANCH_NOT_FOUND: a filial enviada não existe ou é de outra empresa (a mesma resposta). DELIVERY_ROUTE_NOT_FOUND: a rota enviada (`routeId`) não existe ou é de outra empresa (a mesma resposta). TENANT_NOT_FOUND ou BUSINESS_NOT_FOUND: a empresa informada não existe. USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  listVehicleChecklistErrors: errorResponse.describe(
    "VALIDATION_ERROR (ordenação ou filtro fora da lista) ou BUSINESS_NOT_IDENTIFIED (MASTER sem empresa).",
  ),
  createVehicleChecklistErrors: checklistRefusal.describe(
    "VALIDATION_ERROR (corpo fora do schema; `details` diz o quê), PHOTOS_REQUIRED (`missingPhotos` lista os itens sem foto), CHECKLIST_DATE_IN_FUTURE (data depois de hoje no fuso da empresa; uma data só com dia, AAAA-MM-DD, vale como aquele dia), VEHICLE_MILEAGE_INVALID (não passa a quilometragem do veículo, não cabe entre os registros vizinhos da data nem repete a leitura de um deles com menos de 30 minutos de diferença), VEHICLE_NOT_FOUND ou DRIVER_NOT_FOUND (inexistente ou de outra empresa: a mesma resposta), BRANCH_NOT_FOUND (só o MASTER, que pode informar qualquer filial, recebe este 400, para a filial de outra empresa; para os demais a filial enviada que não existe ou é de outra empresa é um 404), BRANCH_REQUIRED (o gestor deixou a filial em branco e nada a resolve: nem o veículo, nem o motorista informado, nem uma única filial ativa da empresa; para o checklist do motorista, a mesma falta responde 409), DRIVER_REQUIRED, CHECKLIST_ROUTE_PHASE_REQUIRED (`routeId` sem `phase` de rota), CHECKLIST_ROUTE_REQUIRED (`phase` de rota sem `routeId`) ou um código do storage para as fotos (ex.: UPLOADED_FILE_NOT_FOUND).",
  ),
  updateVehicleChecklistErrors: checklistRefusal.describe(
    "VALIDATION_ERROR, PHOTOS_REQUIRED (um item alterado exige foto e ele não tem), CHECKLIST_DATE_IN_FUTURE (só quando a edição muda a data), VEHICLE_MILEAGE_OUT_OF_ORDER (a quilometragem nova, ou a data nova, deixaria a leitura fora de ordem entre os registros vizinhos do veículo; a mensagem diz entre quais leituras ela precisa ficar e qual delas pode repetir, a de um registro com menos de 30 minutos de diferença), VEHICLE_MILEAGE_INVALID (o checklist levado para outro veículo não passa a quilometragem dele nem cabe entre os registros vizinhos lá), VEHICLE_NOT_FOUND, DRIVER_NOT_FOUND ou BRANCH_NOT_FOUND (inexistente ou de outra empresa: a mesma resposta) ou um código do storage para as fotos novas.",
  ),
  createForbidden: errorResponse.describe(
    "PERMISSION_DENIED (o perfil não tem escrita em checklists), MODULE_NOT_ENABLED (a empresa não contratou o módulo Frota), TENANT_INACTIVE (a empresa está desativada), TENANT_ACCESS_DENIED (a requisição nomeia outra empresa), BRANCH_INACTIVE (a filial enviada pelo gestor está desativada; a enviada pelo motorista é ignorada, o servidor a resolve) ou VEHICLE_NOT_ASSIGNED_TO_DRIVER (o motorista enviou o checklist de um veículo que não é o dele nem o da rota liberada ou em andamento dele). Definitivo: repetir não muda a resposta.",
  ),
  editForbidden: errorResponse.describe(
    "PERMISSION_DENIED (o perfil não tem escrita em checklists, ou o token é de motorista: motoristas não editam nem excluem checklists, só os enviam pelo app), MODULE_NOT_ENABLED (a empresa não contratou o módulo Frota), TENANT_INACTIVE (a empresa está desativada) ou TENANT_ACCESS_DENIED (a requisição nomeia outra empresa).",
  ),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  // The refusals the app's outbox has to tell apart from a plain 400.
  // `code` is listed so the serializer keeps it: the outbox branches on it.
  writeConflict: z
    .object({
      code: z
        .string()
        .describe(
          "SUBMISSION_OWNER_MISMATCH, BRANCH_REQUIRED, BRANCH_INACTIVE, CHECKLIST_ARRIVAL_ROUTE_OPEN ou CHECKLIST_ARRIVAL_BEFORE_ROUTE_END",
        ),
      message: z.string(),
      // Sent by replyChecklistError with the arrival refusal only.
      open_stops: z
        .number()
        .int()
        .optional()
        .describe(
          "CHECKLIST_ARRIVAL_ROUTE_OPEN: quantas paradas da rota ainda estão em aberto (pendente ou no local). Informativo: decida pelo `code`.",
        ),
    })
    .describe(
      "SUBMISSION_OWNER_MISMATCH: a chave de idempotência já foi usada por outro motorista desta empresa — gere uma chave nova e reenvie; repetir a mesma nunca passa. " +
        "BRANCH_REQUIRED: não há filial ATIVA para registrar o checklist do motorista: nem a do veículo, nem a dele, nem uma única filial ativa da empresa (as desativadas são puladas). Com `routeId`, quem opera as entregas é avisado uma vez por rota e momento, saída ou chegada (`route.record_branch_missing`, na caixa de entrada e na atividade da rota); reenvie depois que o gestor corrigir a filial: os reenvios não repetem o aviso. " +
        "BRANCH_INACTIVE: a filial que o servidor preenche quando o gestor a deixa em branco (a do veículo, ou a do motorista informado) está desativada; uma filial desativada enviada no corpo pelo gestor é recusada antes, com 403. O checklist do motorista nunca vai para uma filial desativada: a filial que o app dele envia no corpo é ignorada. " +
        "CHECKLIST_ARRIVAL_ROUTE_OPEN: o checklist de chegada (`phase` ROUTE_END) do motorista chegou antes de a rota estar resolvida — ela ainda não começou ou tem parada em aberto (pendente ou no local); `open_stops` diz quantas. Só para o app que envia `contract` 5 ou maior em `x-trajetto-client-version`: o de versão anterior, ou sem o cabeçalho, tem o checklist gravado e marcado na atividade, e o do escritório nunca passa por essa regra. Nada foi gravado; reenvie depois que todas as paradas forem resolvidas. O reenvio de um checklist já gravado é respondido com ele antes dessa regra. " +
        "CHECKLIST_ARRIVAL_BEFORE_ROUTE_END: com todas as paradas resolvidas, o checklist de chegada do motorista é datado de antes da última entrega da rota — uma parada foi concluída ou teve insucesso depois da data dele (`completed_at`, o momento do fato), além de 5 minutos de folga para os relógios; uma parada cancelada depois não conta. Acontece com o checklist salvo sem sinal antes de o despachante incluir uma parada, ou com o rascunho de antes dela. Mesmo público da recusa anterior (`contract` 5 ou maior; o de versão anterior tem o checklist gravado como antes). Definitivo: nada foi gravado e o mesmo checklist recebe sempre a mesma resposta; faça um novo checklist de chegada, que, feito agora, passa.",
    ),
  driverInactive: z
    .object({
      code: z.string().describe("DRIVER_INACTIVE"),
      message: z.string(),
    })
    .describe(
      "O motorista informado está inativo. Definitivo: repetir não muda a resposta.",
    ),
  // The create's 422: an inactive driver, or a route that cannot carry it.
  createUnprocessable: z
    .object({
      code: z.string().describe("DRIVER_INACTIVE ou ROUTE_LINK_MISMATCH"),
      message: z.string(),
    })
    .describe(
      "DRIVER_INACTIVE: o motorista informado está inativo. ROUTE_LINK_MISMATCH: a rota informada é de outro motorista, ainda não tem veículo ou tem outro veículo (plano de 02/11/2026, C4/F3). Definitivos: repetir não muda a resposta.",
    ),
  // The edit's only conflict: it carries no idempotency key to collide with.
  branchInactive: z
    .object({
      code: z.string().describe("BRANCH_INACTIVE"),
      message: z.string(),
    })
    .describe(
      "BRANCH_INACTIVE: a filial informada está desativada. Nada foi gravado; repetir não muda a resposta.",
    ),

  // Export errors (GET /export-vehicle-checklist)
  exportVehicleChecklistErrors: errorResponse.describe(
    "NOTHING_TO_EXPORT (nenhum checklist na busca e nos filtros) ou BUSINESS_NOT_IDENTIFIED.",
  ),
  exportBusinessNotFound: errorResponse.describe(
    "BUSINESS_NOT_FOUND (a empresa informada não existe) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
  ),
  // A gone session user is 404; delete's only 400 is a malformed path.
  deleteValidationError: errorResponse.describe(
    "VALIDATION_ERROR: um parâmetro do caminho foi recusado (issues diz qual).",
  ),
  exportForbidden: errorResponse.describe(
    "PERMISSION_DENIED (o perfil não tem escrita em checklists), MODULE_NOT_ENABLED (a empresa não contratou o módulo Frota), TENANT_INACTIVE (a empresa está desativada), TENANT_ACCESS_DENIED (a requisição nomeia outra empresa). Motoristas não exportam os checklists da empresa: recebem PERMISSION_DENIED.",
  ),
};

/** GET /vehicle-checklist/list-vehicle-checklist `meta.searchMeta`. */
const vehicleChecklistSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Checklists da busca e dos demais filtros, sem o de condição (o total dos cartões).",
      ),
    approved: z.number().int().describe("Dos quais aprovados."),
    approvedWithRestrictions: z
      .number()
      .int()
      .describe("Dos quais aprovados com ressalvas."),
    rejected: z.number().int().describe("Dos quais reprovados."),
  },
  ["overall_condition", "branchId", "vehicleId"],
);

export {
  vehicleChecklistSchemas,
  vehicleChecklistResponses,
  vehicleChecklistSearchMetaDoc,
};
