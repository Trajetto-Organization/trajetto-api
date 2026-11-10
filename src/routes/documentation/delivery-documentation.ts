import { z } from "zod";

import { errorResponse, internalErrorResponse } from "./common-responses";

import { OPERATION_COUNTER_TEXT } from "./operation-day-texts";
import { inheritedOpenStopsDoc } from "./inherited-open-stops-documentation";

import { createDeliveryBodySchema } from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import { updateDeliveryStatusSchema } from "@/schemas/update-delivery-status-schema";
import { assignDeliveriesSchema } from "@/schemas/assign-deliveries-schema";

import { deliveryArrivalSchema } from "@/schemas/delivery-arrival-schema";
import { deliveryProofSchema } from "@/schemas/delivery-proof-schema";
import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";

import { importDeliveryXmlSchema } from "@/schemas/import-delivery-xml-schema";
import { listDeliverySchema } from "@/schemas/list-delivery-schema";

import { listOccurrencesSchema } from "@/schemas/list-occurrences-schema";
import { operationSummarySchema } from "@/schemas/operation-summary-schema";

import {
  exportDeliverySchema,
  exportOccurrenceSchema,
} from "@/schemas/export-delivery-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { businessSettingsValuesSchema } from "@/schemas/business-settings-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

import { documentedAs } from "./doc-only-responses";

import { DELIVERY_KINDS } from "@/shared/delivery/delivery-kind";

import {
  occurrenceFormAnswersDoc,
  occurrenceFormFieldsDoc,
} from "@/modules/occurrence-type/form/occurrence-form-documentation";
import {
  decideOccurrenceAuthorizationSchema,
  listPendingAuthorizationsSchema,
  occurrenceAuthorizationParamsSchema,
} from "@/modules/delivery/usecases/authorize-occurrence/occurrence-authorization-schemas";

const authorizationStatusEnum = z.enum([
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "DENIED",
  "SUPERSEDED",
]);

/** What the driver's app needs of each type to report it, offline included. */
const driverOccurrenceTypeEntity = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  requires_photo: z.boolean(),
  blocks_delivery: z.boolean(),
  requires_authorization: z
    .boolean()
    .describe("O relato espera a decisão da torre (decisão 6.3)."),
  form_fields: occurrenceFormFieldsDoc,
  form_version: z
    .number()
    .describe(
      "Enviada de volta no relato (`form_version`) junto com as respostas.",
    ),
  category: z
    .enum(["DELIVERED", "NOT_DELIVERED", "PAUSE"])
    .describe(
      "Categoria (decisão 14.3). Em `occurrence_types`, sempre NOT_DELIVERED.",
    ),
  requires_receipt_photo: z
    .boolean()
    .describe("Exige a foto do canhoto (só pela câmera)."),
  requires_signature: z.boolean().describe("Exige a assinatura na tela."),
});

/** Decision 14.3 (contract 3): what proving a delivery asks, per type. */
const driverDeliveredTypeEntity = driverOccurrenceTypeEntity.extend({
  is_default: z
    .boolean()
    .describe('O tipo padrão "Entrega normal" (o primeiro da lista).'),
});

/**
 * Decision 14.4 (contract 3): a pause type and its legal nature. Also the
 * runtime schema of `pause_types`: a field missing here is stripped from the
 * driver's day (owner, 09/11/2026: `requires_note`).
 */
const driverPauseTypeEntity = z.object({
  id: z.string(),
  name: z.string(),
  pause_kind: z
    .enum(["MEAL", "REST", "OTHER"])
    .describe(
      "A natureza legal (Lei 13.103), enviada como `kind` junto com `occurrence_type_id`.",
    ),
  is_default: z.boolean(),
  requires_note: z
    .boolean()
    .describe(
      'Exige a observação (o motivo) para iniciar; hoje só o tipo padrão "Outra pausa", mesmo renomeado. O app de `contract` 7 em diante pede o motivo antes de enviar; sem ele, o início enviado na hora recebe 400 PAUSE_NOTE_REQUIRED.',
    ),
});

/** Plan of 02/11/2026 (C2): the plate on the route's card. */
const routeVehicleEntity = z
  .object({
    id: z.string(),
    license_plate: z.string(),
  })
  .nullable()
  .describe(
    "O veículo da rota (a placa no card e o veículo do checklist e do abastecimento feitos pela rota); nulo enquanto a rota não tem veículo.",
  );

/** Plan of 02/11/2026 (C4): one checklist made for the route, at one moment. */
const routeChecklistEntity = z
  .object({
    id: z.string(),
    // isoDateTime is declared further down this file.
    checklist_date: z
      .union([z.string(), z.date()])
      .describe("Quando o checklist foi feito."),
    overall_condition: z
      .string()
      .describe("approved, approved_with_restrictions ou rejected."),
  })
  .nullable();

const myDeliveriesRouteEntity = z.object({
  id: z.string(),
  code: z.number(),
  plan_version: z
    .number()
    .describe("Sobe a cada mudança do plano (paradas, ordem, liberação)."),
  vehicle: routeVehicleEntity.optional(),
  checklists: z
    .object({
      route_start: routeChecklistEntity.describe(
        "O checklist de saída mais recente feito para esta rota; nulo = pendente.",
      ),
      route_end: routeChecklistEntity.describe(
        "O checklist de chegada mais recente feito para esta rota; nulo = pendente.",
      ),
    })
    .optional()
    .describe(
      "Plano de 02/11/2026 (C4): o status do checklist de saída e de chegada, derivado dos checklists feitos para a rota. Só diz o que foi feito; o que é exigido está em `settings.checklist_requirement`.",
    ),
  completed_at: z
    .union([z.string(), z.date()])
    .nullable()
    .optional()
    .describe(
      "Plano de 02/11/2026 (C4): nulo numa rota com parada aberta. Preenchido numa rota que já terminou (a última parada foi resolvida) e só continua na lista porque a empresa exige o checklist de chegada (ROUTE_END ou ROUTE_START_AND_END) e ele ainda não foi feito; sai da lista quando o checklist chega ou 24 h depois do fim. Vem depois das rotas abertas.",
    ),
});

/** Plan of 02/11/2026 (M1, M6): what the company decided, as the app applies it. */
const businessSettingsEntity = businessSettingsValuesSchema.describe(
  "Configurações da empresa (plano de 02/11/2026, M1), já com a regra dos módulos (M6): sem Frota e Entregas ligados, o checklist vale NONE; sem Entregas, a geocerca vale DISABLED. O app guarda no cache offline; sem o campo (API antiga), vale o padrão: NONE, DISABLED, 500.",
);

const driverJourneyEntity = z
  .object({
    pause_allowed: z
      .boolean()
      .describe(
        'Rota liberada ou em andamento do dia agora: o app só oferece "Iniciar pausa" então.',
      ),
    route_id: z.string().nullable().describe("A rota da jornada agora."),
    day: z
      .string()
      .describe(
        "O dia da empresa (AAAA-MM-DD, fuso `time_zone`) em que a resposta foi dada: o app só confia em `pause_allowed` em cache enquanto esse dia durar.",
      ),
    time_zone: z
      .string()
      .describe("O fuso da empresa (IANA), ex.: America/Sao_Paulo."),
  })
  .describe("A jornada como o servidor a vê agora (decisão 14.4).");

const deliveryStatusEnum = z.enum([
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
]);

const deliveryListEntity = z.object({
  id: z.string(),
  code: z.string().nullable(),
  invoice_key: z.string().nullable(),
  invoice_number: z.string().nullable(),
  recipient_name: z.string(),
  city: z.string(),
  uf: z.string(),
  status: deliveryStatusEnum,
  kind: z
    .enum(DELIVERY_KINDS)
    .describe(
      "Tipo: DELIVERY (entrega), SERVICE_ORDER (ordem de serviço) ou PICKUP (coleta).",
    ),
  scheduled_date: z.string().nullable(),
  delivered_at: z.string().nullable(),
  shipper: z.object({ id: z.string(), name: z.string() }).nullable(),
  driver: z
    .object({ id: z.string(), name: z.string(), cnh: z.string() })
    .nullable(),
  vehicle: z.object({ id: z.string(), license_plate: z.string() }).nullable(),
  created_at: z.string(),
});

/**
 * The delivery as the driver's app and the detail screen receive it.
 *
 * Documentation only (see `documentedAs`): these bodies pass through the
 * serializer untouched. Dates are ISO strings on the wire; Prisma Decimals
 * (quantities, values) are serialized as strings.
 */
const isoDateTime = z.union([z.string(), z.date()]);
const decimal = z
  .union([z.string(), z.number()])
  .describe("Decimal do banco; chega como string no JSON.");

const deliveryRowEntity = z.object({
  id: z.string(),
  code: z.string().nullable().describe("Código do cliente (ERP)."),
  invoice_key: z.string().nullable().describe("Chave da NF-e."),
  invoice_number: z.string().nullable(),
  recipient_name: z.string(),
  recipient_document: z.string().nullable(),
  recipient_email: z
    .string()
    .nullable()
    .describe(
      'E-mail do destinatário. Vindo da NF-e ou da planilha desde 10/11/2026, até 5 endereços válidos, separados por ";"; antes disso, o campo como estava no arquivo (o aviso ao cliente só escreve para os endereços válidos dele).',
    ),
  recipient_telephone: z.string().nullable(),
  cep: z.string().nullable(),
  city: z.string(),
  uf: z.string(),
  street: z.string(),
  address_number: z.string().nullable(),
  complement: z.string().nullable(),
  neighborhood: z.string().nullable(),
  latitude: z
    .number()
    .nullable()
    .describe(
      "Ponto do ENDEREÇO no mapa da rota (decisão 14.7): um plano, não prova de entrega.",
    ),
  longitude: z.number().nullable(),
  geo_source: z
    .enum(["MANUAL", "GEOCODER"])
    .nullable()
    .describe(
      "MANUAL: fixado no mapa pelo despachante ou informado na criação (formulário, planilha ou API pública). GEOCODER: achado pelo endereço (plano de 02/11/2026, E1). Some quando o endereço muda.",
    ),
  geo_updated_at: isoDateTime.nullable(),
  // Plan of 02/11/2026 (E1): the geocoder's level and its bookkeeping.
  // Optional: a body written by the previous API does not have them.
  geo_precision: z
    .enum(["ADDRESS", "STREET", "NEIGHBORHOOD", "CITY"])
    .nullable()
    .optional()
    .describe(
      "Até onde o geocodificador chegou: ADDRESS (o número) ou STREET (a rua) têm ponto; NEIGHBORHOOD ou CITY ficam sem ponto e a geocerca não avalia. Só vale com geo_source GEOCODER (um ponto MANUAL é exato).",
    ),
  geocode_status: z
    .enum(["RESOLVED", "COARSE", "NOT_FOUND", "FAILED"])
    .nullable()
    .optional()
    .describe(
      "A geocodificação do endereço: nula = ainda não tentada; RESOLVED (ponto gravado), COARSE (só bairro ou cidade, sem ponto), NOT_FOUND ou FAILED (tentada de novo depois).",
    ),
  geocode_attempted_at: isoDateTime
    .nullable()
    .optional()
    .describe("A última tentativa de geocodificação."),
  geocode_attempts: z
    .number()
    .int()
    .optional()
    .describe("Quantas vezes o endereço foi consultado no geocodificador."),
  status: deliveryStatusEnum,
  kind: z
    .enum(DELIVERY_KINDS)
    .describe(
      "Tipo: DELIVERY (entrega), SERVICE_ORDER (ordem de serviço, ex.: recolher cestos retornáveis) ou PICKUP (coleta, criada só pela planilha).",
    ),
  scheduled_date: isoDateTime.nullable(),
  delivered_at: isoDateTime.nullable(),
  received_by: z.string().nullable(),
  notes: z.string().nullable(),
  client_submission_id: z.string().nullable(),
  businessId: z.string(),
  importId: z.string().nullable(),
  apiKeyId: z
    .string()
    .nullable()
    .describe("A chave de API que criou a entrega (origem integração)."),
  shipperId: z.string(),
  vehicleId: z.string().nullable(),
  driverId: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const deliveryItemEntity = z.object({
  id: z.string(),
  description: z.string(),
  quantity: decimal,
  unit: z.string().nullable(),
  unit_value: decimal.nullable(),
  deliveryId: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const person = z.object({ id: z.string(), name: z.string() });

const myDeliveryEntity = deliveryRowEntity.extend({
  shipper: person,
  items: z.array(deliveryItemEntity),
  stops: z
    .array(
      z.object({
        id: z.string(),
        sequence: z.number(),
        status: z.enum([
          "PENDING",
          "ARRIVED",
          "COMPLETED",
          "FAILED",
          "CANCELLED",
        ]),
        arrived_at: isoDateTime
          .nullable()
          .describe(
            "Quando o motorista registrou a chegada nesta parada; nulo antes disso.",
          ),
        on_the_way_at: isoDateTime
          .nullable()
          .describe(
            "Última vez que o motorista avisou estar a caminho desta parada (decisão 6.4); nulo se nunca avisou.",
          ),
        route: z.object({
          id: z.string(),
          code: z.number(),
          name: z.string().nullable(),
          status: z.enum([
            "PLANNED",
            "RELEASED",
            "IN_PROGRESS",
            "COMPLETED",
            "CANCELLED",
          ]),
          destination: z
            .string()
            .nullable()
            .describe("Destino da rota, texto livre, quando foi informado."),
          planned_departure_at: isoDateTime
            .nullable()
            .describe(
              "Saída prevista (instante em UTC); nula quando não foi planejada.",
            ),
          planned_arrival_at: isoDateTime
            .nullable()
            .describe(
              "Retorno previsto (instante em UTC); nulo quando não foi planejado.",
            ),
          scheduled_date: isoDateTime
            .nullable()
            .optional()
            .describe(
              "Dia da rota, SEM hora: meia-noite UTC do dia (`2026-10-05T00:00:00.000Z` é o dia 5). O app compara com o dia da empresa para oferecer a pausa (decisão 14.4).",
            ),
          plan_version: z
            .number()
            .optional()
            .describe(
              "Versão do plano da rota (decisão 14.7); a mesma de routes[].",
            ),
          vehicle: routeVehicleEntity.optional(),
        }),
      }),
    )
    .describe(
      "A parada aberta, quando a entrega está numa rota (no máximo uma): o app ordena o dia por `stops[0].sequence`.",
    ),
  authorization_request: z
    .object({
      occurrenceId: z.string(),
      occurrenceTypeId: z.string(),
      occurrenceTypeName: z.string(),
      status: z.enum(["PENDING", "APPROVED", "DENIED", "SUPERSEDED"]),
      note: z
        .string()
        .nullable()
        .describe("O motivo da torre, sempre presente numa negativa."),
      decidedAt: isoDateTime.nullable(),
      requestedAt: isoDateTime,
    })
    .nullable()
    .describe(
      "O último pedido de autorização da torre (decisão 6.3) feito nesta entrega pelo próprio motorista que consulta: PENDING = 'Aguardando autorização'. Nulo quando ele não pediu; relatos do painel e pedidos de outro motorista que tinha a entrega antes não aparecem. Numa rota, só conta o pedido feito para a parada aberta (criado depois dela): depois de 'Reentregar', a resposta da tentativa anterior não aparece na parada nova.",
    ),
});

/**
 * The geofence record of an action at the customer's address (plan of
 * 02/11/2026, E2-E4): on arrivals, proofs and occurrences.
 */
const geofenceRecordShape = {
  distance_m: z
    .number()
    .nullable()
    .describe(
      "Distância, em metros, entre a posição do celular e o ponto do endereço, calculada pelo servidor; nula sem coordenada de um dos lados.",
    ),
  accuracy_m: z
    .number()
    .nullable()
    .describe("A precisão informada pelo celular, em metros."),
  geofence_outcome: z
    .enum(["INSIDE", "OUTSIDE", "NOT_EVALUATED"])
    .nullable()
    .describe(
      'Dentro ou fora do raio da empresa. OUTSIDE é o selo "Fora do raio" (apontamento confirmado pelo motorista no modo Alertar, ocorrência, ou envio da fila offline aceito e sinalizado). NOT_EVALUATED: sem coordenada no endereço, precisão pior que o raio, posição velha ou geocerca desligada. Nulo nos registros anteriores à geocerca.',
    ),
};

const deliveryEventEntity = z.object({
  id: z.string(),
  type: z.enum([
    "ARRIVAL",
    "PROOF",
    "STATUS_CHANGE",
    "NOTE",
    "ON_THE_WAY",
    "OCCURRENCE",
    "ROUTE_ADDED",
    "ROUTE_REMOVED",
  ]),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  photo: z.string().nullable().describe("URL assinada de vida curta."),
  signature: z.string().nullable().describe("URL assinada de vida curta."),
  received_by: z.string().nullable(),
  actor: z.enum(["USER", "DRIVER_APP", "INTEGRATION", "SYSTEM"]),
  device: z.string().nullable(),
  device_id: z
    .string()
    .nullable()
    .describe(
      "Identificador do celular que registrou o comprovante (decisão 14.8); só DRIVER_APP.",
    ),
  photo_taken_at: isoDateTime
    .nullable()
    .describe(
      "Quando a foto do canhoto foi tirada, pelo relógio corrigido do celular; nulo = occurred_at.",
    ),
  gps_address: z
    .object({
      line: z.string().nullable().optional(),
      district: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      cep: z.string().nullable().optional(),
    })
    .nullable()
    .describe(
      "Endereço do GPS do comprovante por geocodificação reversa, guardado na primeira emissão do PDF.",
    ),
  gps_address_source: z
    .enum(["PROVIDER", "UNAVAILABLE"])
    .nullable()
    .describe(
      "UNAVAILABLE: a consulta falhou ou não há provedor; o PDF imprime o endereço da entrega, rotulado.",
    ),
  gps_geocoded_at: isoDateTime.nullable(),
  note: z.string().nullable(),
  status_from: deliveryStatusEnum.nullable(),
  status_to: deliveryStatusEnum.nullable(),
  reasonId: z.string().nullable(),
  client_submission_id: z.string().nullable(),
  deliveryId: z.string(),
  businessId: z.string(),
  routeId: z.string().nullable(),
  occurrenceId: z
    .string()
    .nullable()
    .describe("A ocorrência que o evento registra, quando houver."),
  reportedById: z.string().nullable(),
  apiKeyId: z
    .string()
    .nullable()
    .describe(
      "A chave de API que agiu, quando o ator é INTEGRATION (cancelamento pela API).",
    ),
  occurred_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  reportedBy: person.nullable(),
  reason: person
    .nullable()
    .describe("O motivo do catálogo, na mudança manual."),
  apiKey: person
    .nullable()
    .describe(
      "A chave de API (id e nome) quando o ator é INTEGRATION; nula nos demais.",
    ),
  ...geofenceRecordShape,
});

const deliveryOccurrenceEntity = z.object({
  id: z.string(),
  description: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  photos: z.array(z.string()).describe("URLs assinadas de vida curta."),
  client_submission_id: z.string().nullable(),
  deliveryId: z.string(),
  businessId: z.string(),
  occurrenceTypeId: z.string(),
  reportedById: z.string(),
  occurred_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  // Occurrence form (decision 6.2) and tower authorization (6.3).
  form_answers: occurrenceFormAnswersDoc,
  form_version: z.number().nullable(),
  authorization_status: authorizationStatusEnum,
  authorizedById: z.string().nullable(),
  authorized_at: isoDateTime.nullable(),
  authorization_note: z.string().nullable(),
  // Decision 14.3: a DELIVERED occurrence carries the proof's facts too; the
  // signed URLs of the receipt and the signature are on its PROOF event.
  category: z
    .enum(["DELIVERED", "NOT_DELIVERED", "PAUSE"])
    .describe("Categoria do tipo relatado (decisão 14.3)."),
  receipt_photo: z
    .string()
    .nullable()
    .describe("Chave da foto do canhoto, quando houve."),
  signature: z
    .string()
    .nullable()
    .describe("Chave da assinatura na tela, quando houve."),
  received_by: z.string().nullable().describe("Quem recebeu (só em entrega)."),
  escalated_at: isoDateTime.nullable(),
  occurrenceType: z.object({
    id: z.string(),
    name: z.string(),
    blocks_delivery: z.boolean(),
    requires_authorization: z.boolean(),
    form_fields: occurrenceFormFieldsDoc.describe(
      "O formulário ATUAL do tipo: rotula as respostas (a versão respondida está em `form_version`).",
    ),
    form_version: z.number(),
  }),
  reportedBy: person,
  authorizedBy: person
    .nullable()
    .describe("Quem autorizou ou negou; nulo enquanto pendente ou sem pedido."),
  ...geofenceRecordShape,
});

const timelineEntryEntity = z.object({
  id: z.string(),
  kind: z.enum([
    "ARRIVAL",
    "PROOF",
    "STATUS_CHANGE",
    "NOTE",
    "ON_THE_WAY",
    "OCCURRENCE",
    "MESSAGE",
    "ROUTE_ADDED",
    "ROUTE_REMOVED",
  ]),
  at: isoDateTime,
  title: z.string(),
  detail: z.string().nullable(),
  author: z.object({
    kind: z.enum(["USER", "DRIVER_APP", "INTEGRATION", "SYSTEM"]),
    name: z.string().nullable(),
    device: z.string().nullable(),
  }),
  photos: z.array(z.string()),
  location: z
    .object({ latitude: z.number(), longitude: z.number() })
    .nullable(),
  statusFrom: deliveryStatusEnum.nullable(),
  statusTo: deliveryStatusEnum.nullable(),
  reason: z.string().nullable(),
  blocking: z.boolean(),
});

/**
 * Contract C2 (03/11/2026): since when the delivery's recipient stopped
 * receiving this company's customer messages, per channel.
 */
const messageOptOutEntity = z
  .object({
    whatsapp: z
      .string()
      .nullable()
      .describe(
        'Desde quando (ISO 8601) o telefone do destinatário desta entrega não recebe WhatsApp desta transportadora (descadastro por "Parar de receber", D38); null enquanto recebe ou sem telefone.',
      ),
    email: z
      .string()
      .nullable()
      .describe(
        "Desde quando (ISO 8601) o e-mail do destinatário desta entrega não recebe e-mail desta transportadora; null enquanto recebe ou sem e-mail.",
      ),
  })
  .describe(
    "O descadastro do destinatário nesta transportadora, pelo telefone e pelo e-mail atuais da entrega (comparados na forma normalizada, como no envio). Desfeito por POST /delivery/reactivate-customer-messages.",
  );

const deliveryDetailEntity = deliveryRowEntity.extend({
  shipper: person,
  import: z
    .object({ source: z.enum(["SPREADSHEET", "NFE_XML"]) })
    .nullable()
    .describe(
      "A importação que criou a entrega: itens de XML de NF-e não são editáveis.",
    ),
  driver: z
    .object({ id: z.string(), name: z.string(), cnh: z.string() })
    .nullable(),
  vehicle: z.object({ id: z.string(), license_plate: z.string() }).nullable(),
  items: z.array(deliveryItemEntity),
  events: z.array(deliveryEventEntity).describe("Mais recente primeiro."),
  occurrences: z
    .array(deliveryOccurrenceEntity)
    .describe("Mais recente primeiro."),
  chatMessages: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["TEXT", "IMAGE", "AUDIO"]),
        body: z.string().nullable(),
        created_at: isoDateTime,
        sender: person,
      }),
    )
    .describe("As últimas 50 mensagens que citaram esta entrega."),
  timeline: z
    .array(timelineEntryEntity)
    .describe("Tudo o que aconteceu com a entrega, mais recente primeiro."),
  messageOptOut: messageOptOutEntity,
});

const deliverySchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  deliveryBusinessParams: updateDeleteBusinessSchema.merge(
    updateDeleteDeliverySchema,
  ),
  createDelivery: createDeliveryBodySchema,
  updateDelivery: updateDeliverySchema,
  updateDeliveryStatus: updateDeliveryStatusSchema,
  assignDeliveries: assignDeliveriesSchema,
  deliveryArrival: deliveryArrivalSchema,
  deliveryProof: deliveryProofSchema,
  reportOccurrence: reportDeliveryOccurrenceSchema,
  importDeliveryXml: importDeliveryXmlSchema,
  listDeliveries: listDeliverySchema,
  listOccurrences: listOccurrencesSchema,
  operationSummary: operationSummarySchema,
  exportDelivery: exportDeliverySchema,
  exportOccurrence: exportOccurrenceSchema,
  occurrenceAuthorizationParams: occurrenceAuthorizationParamsSchema,
  decideOccurrenceAuthorization: decideOccurrenceAuthorizationSchema,
  listPendingAuthorizations: listPendingAuthorizationsSchema,
};

/** One request of the tower's queue, as the web's queue shows it. */
const pendingAuthorizationFull = z.object({
  id: z.string(),
  deliveryId: z.string(),
  occurrenceTypeId: z.string(),
  occurrenceType: z.object({
    id: z.string(),
    name: z.string(),
    blocks_delivery: z.boolean(),
  }),
  description: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  photos: z.array(z.string()).describe("URLs assinadas de vida curta."),
  category: z
    .enum(["DELIVERED", "NOT_DELIVERED", "PAUSE"])
    .describe(
      "Categoria do tipo (decisão 14.3). DELIVERED: aprovar comprova a entrega com o canhoto e a assinatura abaixo.",
    ),
  receipt_photo_url: z
    .string()
    .nullable()
    .describe("Foto do canhoto, URL assinada de vida curta; null sem canhoto."),
  signature_url: z
    .string()
    .nullable()
    .describe(
      "Assinatura na tela, URL assinada de vida curta; null sem assinatura.",
    ),
  received_by: z
    .string()
    .nullable()
    .describe(
      "Quem recebeu, informado pelo motorista (só pedidos de entrega).",
    ),
  form_answers: occurrenceFormAnswersDoc,
  form_version: z.number().nullable(),
  form_fields: occurrenceFormFieldsDoc,
  answers: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe(
      "As respostas já rotuladas e formatadas, na ordem do formulário.",
    ),
  reportedBy: person,
  occurred_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  escalated_at: isoDateTime
    .nullable()
    .describe("Quando o pedido sem resposta foi escalado aos administradores."),
  escalates_at: isoDateTime.describe(
    "Quando escala (10 min depois do pedido).",
  ),
  delivery: z.object({
    id: z.string(),
    code: z.string().nullable(),
    invoice_number: z.string().nullable(),
    recipient_name: z.string(),
    street: z.string(),
    address_number: z.string().nullable(),
    neighborhood: z.string().nullable(),
    city: z.string(),
    uf: z.string(),
    status: deliveryStatusEnum,
    driver: person.nullable(),
  }),
});

/**
 * One request as the app's list shows it (wave 4): the full row minus the
 * signed URLs, the place and the form, plus what waits in the detail.
 */
const pendingAuthorizationSummary = pendingAuthorizationFull
  .pick({
    id: true,
    deliveryId: true,
    occurrenceTypeId: true,
    occurrenceType: true,
    category: true,
    description: true,
    reportedBy: true,
    occurred_at: true,
    created_at: true,
    escalated_at: true,
    escalates_at: true,
    delivery: true,
  })
  .extend({
    photos_count: z
      .number()
      .describe("Quantas fotos o pedido tem (as URLs vêm na visão full)."),
    has_receipt_photo: z
      .boolean()
      .describe("Pedido de entrega com foto do canhoto."),
    has_signature: z.boolean().describe("Pedido de entrega com assinatura."),
  });

const pendingAuthorizationsTotal = z
  .number()
  .describe(
    "Quantos aguardam ao todo (a lista traz no máximo 100); com `occurrenceId`, 1 ou 0.",
  );

const deliveryResponses = {
  deliveryCreated: z.object({
    message: z.string().default("Entrega criada com sucesso!"),
    data: z.object({ id: z.string() }),
  }),
  deliveryUpdated: z.object({
    message: z.string().default("Entrega atualizada com sucesso!"),
  }),
  deliveryStatusUpdated: z.object({
    message: z.string().default("Status da entrega atualizado com sucesso!"),
  }),
  deliveriesAssigned: z.object({
    message: z.string().default("Entregas atribuídas com sucesso!"),
    data: z.object({
      assigned: z.number().describe("How many deliveries the route carries"),
      routeId: z.string().describe("The route the assignment created"),
      routeCode: z.number().describe("Its per-company number"),
    }),
  }),
  // Runtime: the deliveries pass through (`z.unknown()`), because a strict
  // schema would strip any field the app's offline cache reads and this file
  // forgot — and store builds are older than this code. Document: the typed
  // row, held to the real payload by tests/E2E/delivery-documented-shapes.
  // The types' runtime schema is the typed one: it must list the form and
  // the authorization flag, or the serializer would strip them (6.2, 6.3).
  myDeliveries: documentedAs(
    z.object({
      data: z.array(z.unknown()),
      routes: z.array(myDeliveriesRouteEntity),
      occurrence_types: z.array(driverOccurrenceTypeEntity),
      delivered_types: z.array(driverDeliveredTypeEntity),
      pause_types: z.array(driverPauseTypeEntity),
      journey: driverJourneyEntity,
      settings: businessSettingsEntity.optional(),
    }),
    z.object({
      data: z.array(myDeliveryEntity),
      routes: z
        .array(myDeliveriesRouteEntity)
        .describe(
          "Decisão 14.7: as rotas das paradas abertas da lista, uma vez cada, com a versão do plano. O app guarda no cache e avisa uma vez quando o plano mudou enquanto estava sem sinal.",
        ),
      occurrence_types: z
        .array(driverOccurrenceTypeEntity)
        .describe(
          "Só os tipos de NÃO ENTREGA ativos: o app instalado (contrato 2) os oferece como problema.",
        ),
      delivered_types: z
        .array(driverDeliveredTypeEntity)
        .describe(
          "Contrato 3: os tipos de ENTREGA ativos, o padrão primeiro; comprovar = relatar um deles.",
        ),
      pause_types: z
        .array(driverPauseTypeEntity)
        .describe("Contrato 3: os tipos de PAUSA ativos."),
      journey: driverJourneyEntity,
      settings: businessSettingsEntity,
    }),
  ),
  routeStarted: z.object({
    message: z.string(),
    data: z.object({ started: z.number() }),
  }),
  arrivalRegistered: z.object({
    message: z.string().default("Chegada registrada com sucesso!"),
  }),
  proofRegistered: z.object({
    message: z
      .string()
      .default("Entrega comprovada com sucesso!")
      .describe(
        '"Entrega comprovada com sucesso!", ou "Entrega registrada. Aguardando autorização da torre." quando o tipo padrão exige autorização.',
      ),
  }),
  legacyProofOutdated: z
    .object({
      code: z
        .string()
        .describe("CLIENT_OUTDATED, VALIDATION_ERROR ou outro código de 400"),
      message: z.string(),
      missing: z
        .array(z.enum(["signature", "photos", "form"]))
        .optional()
        .describe(
          "CLIENT_OUTDATED: o que o tipo padrão passou a exigir e este aplicativo não envia.",
        ),
      issues: z.array(z.string()).optional(),
    })
    .describe(
      'CLIENT_OUTDATED (com `missing`): a empresa passou a exigir no tipo padrão "Entrega normal" algo que esta versão do aplicativo não envia (assinatura, fotos ou formulário). A fila do aplicativo guarda o comprovante e o reenvia depois da atualização. Também VALIDATION_ERROR, INVALID_STATUS_TRANSITION e os demais códigos do relato.',
    ),
  occurrenceReported: z.object({
    message: z.string().default("Ocorrência registrada com sucesso!"),
    data: z.object({
      id: z
        .string()
        .describe("A ocorrência gravada (ou a já gravada, num reenvio)."),
      authorization_status: authorizationStatusEnum.describe(
        "NOT_REQUIRED: efeito aplicado agora. PENDING: aguardando a torre, sem efeito. APPROVED: relato do painel, num tipo que pede autorização, por quem pode decidir na torre (o autor autoriza). SUPERSEDED: a tentativa já tinha terminado (entrega entregue, cancelada ou com insucesso, ou fora das mãos deste motorista), então não há o que autorizar.",
      ),
      replayed: z
        .boolean()
        .describe(
          "Verdadeiro quando o envio repetiu um `client_submission_id` já gravado.",
        ),
      category: z
        .enum(["DELIVERED", "NOT_DELIVERED", "PAUSE"])
        .describe("Categoria do tipo relatado (decisão 14.3)."),
      delivery_status: deliveryStatusEnum.describe(
        "O status da entrega depois do relato (DELIVERED quando uma entrega foi registrada e aplicada).",
      ),
      ticket: z
        .object({ id: z.string(), number: z.number().int() })
        .nullable()
        .describe(
          "O atendimento (ticket) aberto pelo relato (decisão 14.5): pedido de autorização ou ocorrência do motorista. Null quando o relato não abre atendimento. Num reenvio, o mesmo atendimento.",
        ),
      late_proof: z
        .enum(["APPLIED", "EVIDENCE"])
        .optional()
        .describe(
          'Só num comprovante que chegou depois de a entrega sair das mãos do motorista que o enviou (K7, decisão D27: a rota foi cancelada ou o status mudou no painel enquanto ele estava sem sinal). APPLIED: o toque (`occurred_at`) foi antes disso e a entrega ainda podia ser entregue — aceita como ENTREGUE, de volta ao motorista e ao veículo da rota, com um apontamento do sistema na linha do tempo e um atendimento para a torre. EVIDENCE: tocado depois, sem `occurred_at`, entrega cancelada, com outro motorista, já planejada de novo em outra rota ou tipo que pede autorização — guardada como evidência sem efeito (`authorization_status` SUPERSEDED, canhoto e assinatura preservados), com o apontamento e o atendimento. O app mostra "Enviado para análise da central". Ausente em todo outro relato.',
        ),
    }),
  }),
  occurrenceFormInvalid: z
    .object({
      code: z
        .string()
        .describe(
          "OCCURRENCE_FORM_INVALID, CLIENT_OUTDATED ou outro código de 400",
        ),
      message: z.string(),
      field_errors: z
        .record(z.string())
        .optional()
        .describe("Por `key` do campo, o primeiro problema encontrado."),
      issues: z.array(z.string()).optional(),
      form_fields: occurrenceFormFieldsDoc
        .optional()
        .describe(
          "CLIENT_OUTDATED: o formulário atual do tipo, para um app que saiba exibi-lo.",
        ),
      form_version: z
        .number()
        .optional()
        .describe("CLIENT_OUTDATED: a versão atual do formulário."),
    })
    .describe(
      "Corpo inválido (VALIDATION_ERROR com `issues`), respostas que não atendem o formulário (OCCURRENCE_FORM_INVALID com `field_errors`), relato de motorista sem `form_version` (app anterior aos formulários) cujas respostas não atendem o formulário (CLIENT_OUTDATED, com `field_errors`, `form_fields` e `form_version`: o app precisa ser atualizado; a fila do app guarda o item e o reenvia depois da atualização), tipo de sistema (OCCURRENCE_TYPE_NOT_REPORTABLE), tipo desativado (OCCURRENCE_TYPE_INACTIVE), tipo de pausa (OCCURRENCE_TYPE_WRONG_CATEGORY), exigências do tipo não atendidas pelo motorista (OCCURRENCE_RECEIPT_PHOTO_REQUIRED, OCCURRENCE_SIGNATURE_REQUIRED, OCCURRENCE_PHOTO_REQUIRED) ou entrega que não pode mais ser entregue (INVALID_STATUS_TRANSITION).",
    ),
  occurrenceReportConflict: z
    .object({
      code: z
        .string()
        .describe(
          "OCCURRENCE_FORM_OUTDATED, DELIVERY_STATUS_CONFLICT ou SUBMISSION_ID_REUSED",
        ),
      message: z.string(),
      field_errors: z.record(z.string()).optional(),
      form_fields: occurrenceFormFieldsDoc.optional(),
      form_version: z.number().optional(),
    })
    .describe(
      "OCCURRENCE_FORM_OUTDATED: o formulário mudou desde que o app o exibiu e as respostas não servem mais; traz o formulário atual (`form_fields`, `form_version`) para reabrir com as respostas. DELIVERY_STATUS_CONFLICT: a entrega mudou de status durante o envio e nada foi gravado. SUBMISSION_ID_REUSED: o `client_submission_id` já foi usado em outro registro (outra entrega, outro tipo de evento ou outra empresa); nada foi gravado e repetir a mesma chave nunca passa — gere uma chave nova.",
    ),
  occurrenceAuthorizationDecided: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      deliveryId: z.string(),
      authorization_status: z.enum(["APPROVED", "DENIED"]),
      authorized_at: isoDateTime,
      authorizedBy: person,
      authorization_note: z.string().nullable(),
      deliveryStatus: deliveryStatusEnum.describe(
        "O status da entrega depois da decisão (Insucesso após autorizar um tipo impeditivo).",
      ),
      replayed: z
        .boolean()
        .describe(
          "Verdadeiro quando a mesma pessoa repetiu a mesma decisão: nada foi gravado de novo.",
        ),
    }),
  }),
  occurrenceAlreadyDecided: z
    .object({
      code: z
        .string()
        .describe(
          "OCCURRENCE_ALREADY_DECIDED, OCCURRENCE_AUTHORIZATION_NOT_REQUIRED ou DELIVERY_STATUS_CONFLICT",
        ),
      message: z.string(),
      decision: z
        .object({
          status: z.enum(["APPROVED", "DENIED", "SUPERSEDED"]),
          authorizedBy: person.nullable(),
          authorized_at: isoDateTime.nullable(),
          note: z.string().nullable(),
        })
        .optional()
        .describe("A decisão que vale (OCCURRENCE_ALREADY_DECIDED)."),
    })
    .describe(
      "Outra pessoa decidiu antes, ou a comprovação da entrega encerrou o pedido (SUPERSEDED): nada desta requisição foi gravado.",
    ),
  /**
   * The tower's queue, in the view the caller asked for (wave 4). `view`
   * names the branch, and the serializer parses the body with it, so the
   * app's polled list can never carry a signed URL.
   */
  pendingAuthorizations: z.discriminatedUnion("view", [
    z.object({
      view: z.literal("full").describe("A fila da torre (padrão; a web)."),
      data: z.array(pendingAuthorizationFull),
      total: pendingAuthorizationsTotal,
      businessId: z.string(),
    }),
    z.object({
      view: z
        .literal("summary")
        .describe("A lista do app: sem URL assinada nem formulário."),
      data: z.array(pendingAuthorizationSummary),
      total: pendingAuthorizationsTotal,
      businessId: z.string(),
    }),
  ]),
  deliveriesImported: z.object({
    message: z.string(),
    data: z.object({
      importId: z
        .string()
        .describe(
          "A linha de Importações desta importação (pode ser estornada).",
        ),
      imported: z.number(),
      duplicated: z.number(),
      invalid: z.number(),
      created_shippers: z
        .array(z.string())
        .describe("Embarcadores criados a partir do emitente das notas."),
      results: z.array(
        z.object({
          filename: z.string(),
          outcome: z.enum(["imported", "duplicated", "invalid"]),
          invoice_key: z.string().nullable(),
          recipient_name: z.string().nullable(),
          message: z
            .string()
            .nullable()
            .describe(
              "Motivo acionável quando o arquivo não virou entrega. Num arquivo importado, os e-mails do destinatário que ficaram de fora dos avisos ao cliente (os dois primeiros entre aspas), ou nulo.",
            ),
        }),
      ),
    }),
  }),
  deliveryList: z.object({
    data: z.array(deliveryListEntity),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  // Same rule as myDeliveries: passed through at runtime, typed in the
  // document, held to the real payload by the E2E drift test.
  // `meta` is declared on the runtime schema too: the serializer drops a
  // key it does not list.
  deliveryDetail: documentedAs(
    z.object({
      data: z.unknown(),
      meta: z.object({ timeZone: z.string() }),
    }),
    z.object({
      data: deliveryDetailEntity,
      meta: z.object({
        timeZone: z
          .string()
          .describe(
            "O fuso da empresa (IANA), ex.: America/Sao_Paulo: o detalhe mostra nele as datas da entrega, como as de `messageOptOut`, igual ao detalhe da rota e às abas da torre (decisão D22). Sem ele (versão anterior da API), o navegador.",
          ),
      }),
    }),
  ),
  /**
   * One line of the occurrence feed. The feed is NDJSON, so this documents
   * the lines; the repository's `include` is the shape, and the photos are
   * signed URLs by the time they leave.
   */
  occurrenceFeedRow: z.object({
    id: z.string(),
    description: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    photos: z
      .array(z.string())
      .describe("URLs assinadas de vida curta, não caminhos de storage."),
    client_submission_id: z.string().nullable(),
    deliveryId: z.string(),
    businessId: z.string(),
    occurrenceTypeId: z.string(),
    reportedById: z.string(),
    occurred_at: z.union([z.string(), z.date()]).nullable(),
    created_at: z.union([z.string(), z.date()]),
    updated_at: z.union([z.string(), z.date()]),
    // The feed reads the whole row: the form answers (6.2) and the tower's
    // authorization (6.3) come along.
    form_answers: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .nullable()
      .describe(
        "Respostas do formulário do tipo de ocorrência, por chave do campo.",
      ),
    form_version: z.number().nullable(),
    authorization_status: z.enum([
      "NOT_REQUIRED",
      "PENDING",
      "APPROVED",
      "DENIED",
      "SUPERSEDED",
    ]),
    authorizedById: z.string().nullable(),
    authorized_at: z.union([z.string(), z.date()]).nullable(),
    authorization_note: z.string().nullable(),
    escalated_at: z.union([z.string(), z.date()]).nullable(),
    occurrenceType: z.object({
      id: z.string(),
      name: z.string(),
      blocks_delivery: z.boolean(),
      requires_photo: z.boolean(),
    }),
    reportedBy: z.object({ id: z.string(), name: z.string() }),
    delivery: z.object({
      id: z.string(),
      recipient_name: z.string(),
      status: deliveryStatusEnum,
      city: z.string(),
      uf: z.string(),
      code: z.string().nullable(),
    }),
  }),
  operationSummaryResult: z.object({
    data: z.object({
      // The same texts as the dashboard's deliveryOperation: one definition
      // of the day's load (decision 7.1), whichever screen reads it.
      totals: z.object({
        unassigned: z
          .number()
          .describe(
            "Pendentes sem motorista, de qualquer data (o que ainda deve rota).",
          ),
        designated: z.number().describe(OPERATION_COUNTER_TEXT.designated),
        inRoute: z.number().describe(OPERATION_COUNTER_TEXT.inRoute),
        deliveredToday: z
          .number()
          .describe(OPERATION_COUNTER_TEXT.deliveredToday),
        failedToday: z.number().describe(OPERATION_COUNTER_TEXT.failedToday),
        occurrencesToday: z
          .number()
          .describe(
            "Ocorrências relatadas por motoristas no dia de negócio da empresa, pela hora em que aconteceram; não conta anotações do painel nem tipos de sistema.",
          ),
      }),
      drivers: z
        .array(
          z.object({
            driverId: z.string(),
            driverName: z.string(),
            cnh: z.string(),
            designated: z.number().describe(OPERATION_COUNTER_TEXT.designated),
            inRoute: z.number().describe(OPERATION_COUNTER_TEXT.inRoute),
            deliveredToday: z
              .number()
              .describe(OPERATION_COUNTER_TEXT.deliveredToday),
            failedToday: z
              .number()
              .describe(OPERATION_COUNTER_TEXT.failedToday),
          }),
        )
        .describe(
          "Os mesmos motoristas e contagens de GET /route/monitoring/drivers para o mesmo dia; 'hoje' é o dia civil no fuso da empresa.",
        ),
      inherited: inheritedOpenStopsDoc(
        "Paradas ainda abertas (pendentes ou com chegada) nessas rotas: documentos que `inRoute` conta hoje, herdados de dias anteriores.",
        'O que `inRoute` herdou de rotas esquecidas abertas (H3), com a mesma regra e os mesmos números do `inherited` de GET /route/control-tower, para a nota "inclui N de rotas abertas desde dd/mm".',
      ),
    }),
  }),
  genericError: errorResponse,
  // An error whose `code` the clients branch on. Listed so the serializer
  // keeps it: the app's outbox parks on MODULE_NOT_ENABLED and refreshes on
  // DELIVERY_STATUS_CONFLICT, and neither survives `genericError`. `issues`
  // comes only with a 400 VALIDATION_ERROR.
  codedError: z.object({
    code: z.string().optional(),
    message: z.string(),
    issues: z.array(z.string()).optional(),
  }),
  statusConflict: z
    .object({
      code: z
        .string()
        .describe("DELIVERY_STATUS_CONFLICT ou SUBMISSION_ID_REUSED"),
      message: z.string(),
    })
    .describe(
      "DELIVERY_STATUS_CONFLICT: o status da entrega mudou entre a leitura e a gravação (outra tela, outro aparelho) e nada foi gravado. Atualize a entrega e decida de novo; repetir o mesmo envio não passa. SUBMISSION_ID_REUSED (só nas rotas do motorista com `client_submission_id`): a chave já foi usada em outro registro (outra entrega, outro tipo de evento ou outra empresa); nada foi gravado — gere uma chave nova.",
    ),
  internalServerError: internalErrorResponse,
  // Contract C2: the undo answers the state as the detail shows it.
  customerMessagesReactivated: z.object({
    message: z.string().default("Mensagens ao cliente reativadas."),
    data: z.object({ messageOptOut: messageOptOutEntity }),
  }),
};

export { deliverySchemas, deliveryResponses };
