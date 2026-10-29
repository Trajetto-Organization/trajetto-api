import type {
  PublicDelivery,
  PublicEvent,
  PublicRoute,
} from "@/shared/integration/public-shapes";
import {
  TOPIC_FAMILY,
  WEBHOOK_API_VERSION,
} from "@/shared/integration/webhook-catalogue";

import { buildCatalogue } from "./integration-documentation";

/**
 * Example success bodies for the surfaces written against from outside this
 * repository: the public integration API (/integration/v1) and the driver's
 * delivery loop.
 *
 * Documentation only. The OpenAPI transform hangs each one on its response as
 * `examples: [body]`, which @fastify/swagger publishes as the media type's
 * `example` — in /docs and, by subtraction, in the public portal. Nothing
 * here reaches a serializer: the runtime schemas are untouched, so what old
 * app builds receive cannot change.
 *
 * Each example is held to the schema it illustrates, every field and no
 * more, by tests/unitaires/contract/response-examples.test.ts — so it cannot
 * quietly describe a body the API does not send. Dates are ISO strings and
 * Prisma Decimals are strings, as on the wire.
 *
 * Keyed by `METHOD <fastify url>`, then by status.
 */
type ResponseExamples = Record<string, Record<string, unknown>>;

const BUSINESS_ID = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const DELIVERY_ID = "0192f7f0-5c1e-7a3b-9d2e-4f6a8b0c1d2e";
const NEXT_DELIVERY_ID = "0192f7f0-6d2f-7b4c-8e3f-5a7b9c1d2e3f";
const ROUTE_ID = "0192f7f1-2b3c-7d4e-9f5a-6b7c8d9e0f1a";
const DRIVER_ID = "0192f7d0-3c4d-7e5f-8a6b-7c8d9e0f1a2b";
const DRIVER_USER_ID = "0192f7d1-4d5e-7f6a-9b7c-8d9e0f1a2b3c";
const VEHICLE_ID = "0192f7c0-5e6f-7a7b-8c8d-9e0f1a2b3c4d";
const SHIPPER_ID = "0192f7b0-6f7a-7b8c-9d9e-0f1a2b3c4d5e";

const INVOICE_KEY = "35260912345678000190550010000104521000104529";
const NEXT_INVOICE_KEY = "35260912345678000190550010000104531000104534";

// ---------------------------------------------------------------- public API

const publicDelivery: PublicDelivery = {
  id: DELIVERY_ID,
  code: "PED-10452",
  invoice_key: INVOICE_KEY,
  invoice_number: "10452",

  status: "IN_TRANSIT",
  status_label: "Em rota",

  kind: "DELIVERY",

  recipient: {
    name: "Mercado Bom Preço Ltda",
    document: "12345678000190",
    address: {
      street: "Rua das Flores",
      number: "120",
      complement: "Loja 2",
      neighborhood: "Centro",
      city: "Campinas",
      uf: "SP",
      zip_code: "13010000",
    },
  },

  scheduled_date: "2026-09-24T00:00:00.000Z",
  delivered_at: null,
  received_by: null,

  route: { id: ROUTE_ID, code: 318 },

  created_at: "2026-09-23T18:42:10.000Z",
  updated_at: "2026-09-24T08:15:32.000Z",
};

/** What POST /integration/v1/deliveries answers: just created, no route yet. */
const createdPublicDelivery: PublicDelivery = {
  ...publicDelivery,

  status: "PENDING",
  status_label: "Pendente",

  route: null,

  created_at: "2026-09-23T18:42:10.000Z",
  updated_at: "2026-09-23T18:42:10.000Z",
};

const publicRoute: PublicRoute = {
  id: ROUTE_ID,
  code: 318,
  name: "Campinas — manhã",

  status: "IN_PROGRESS",

  scheduled_date: "2026-09-24T00:00:00.000Z",
  destination: "CD Campinas",
  planned_departure_at: "2026-09-24T07:00:00.000Z",
  planned_arrival_at: "2026-09-24T17:00:00.000Z",
  started_at: "2026-09-24T07:05:00.000Z",
  completed_at: null,

  driver: { id: DRIVER_ID, name: "João da Silva" },
  vehicle: { id: VEHICLE_ID, license_plate: "ABC1D23" },

  stops: [
    {
      sequence: 1,
      status: "COMPLETED",
      delivery: {
        id: NEXT_DELIVERY_ID,
        code: "PED-10453",
        invoice_key: NEXT_INVOICE_KEY,
      },
    },
    {
      sequence: 2,
      status: "PENDING",
      delivery: {
        id: DELIVERY_ID,
        code: "PED-10452",
        invoice_key: INVOICE_KEY,
      },
    },
  ],

  created_at: "2026-09-23T19:10:00.000Z",
};

const publicEvents: PublicEvent[] = [
  {
    id: "0192f7f2-7a8b-7c9d-8e0f-1a2b3c4d5e6f",
    topic: "delivery.delivered",
    occurred_at: "2026-09-24T09:41:07.000Z",
    delivery: {
      id: NEXT_DELIVERY_ID,
      code: "PED-10453",
      invoice_key: NEXT_INVOICE_KEY,
    },
    data: {
      status_from: "IN_TRANSIT",
      status_to: "DELIVERED",
      received_by: "Maria Souza",
      note: null,
    },
  },
  {
    id: "0192f7f2-8b9c-7d0e-9f1a-2b3c4d5e6f7a",
    topic: "proof.registered",
    occurred_at: "2026-09-24T09:41:07.000Z",
    delivery: {
      id: NEXT_DELIVERY_ID,
      code: "PED-10453",
      invoice_key: NEXT_INVOICE_KEY,
    },
    data: {
      status_from: null,
      status_to: null,
      received_by: "Maria Souza",
      note: null,
    },
  },
];

// ------------------------------------------------------- driver's delivery loop

const deliveryRow = {
  id: DELIVERY_ID,
  code: "PED-10452",
  invoice_key: INVOICE_KEY,
  invoice_number: "10452",
  recipient_name: "Mercado Bom Preço Ltda",
  recipient_document: "12345678000190",
  recipient_email: null,
  recipient_telephone: "19999990000",
  cep: "13010000",
  city: "Campinas",
  uf: "SP",
  street: "Rua das Flores",
  address_number: "120",
  complement: "Loja 2",
  neighborhood: "Centro",
  // Decision 14.7: the address point on the route map, pinned by hand.
  latitude: -22.9056,
  longitude: -47.0608,
  geo_source: "MANUAL",
  geo_updated_at: "2026-09-23T19:05:00.000Z",
  status: "IN_TRANSIT",
  kind: "DELIVERY",
  scheduled_date: "2026-09-24T00:00:00.000Z",
  delivered_at: null,
  received_by: null,
  notes: "Receber pela doca lateral.",
  client_submission_id: null,
  businessId: BUSINESS_ID,
  importId: null,
  apiKeyId: null,
  shipperId: SHIPPER_ID,
  vehicleId: VEHICLE_ID,
  driverId: DRIVER_ID,
  created_at: "2026-09-23T18:42:10.000Z",
  updated_at: "2026-09-24T08:15:32.000Z",
};

const deliveryItem = {
  id: "0192f7f3-9c0d-7e1f-8a2b-3c4d5e6f7a8b",
  description: "Caixa de óleo 20W50 (12 un.)",
  quantity: "4",
  unit: "CX",
  unit_value: "389.90",
  deliveryId: DELIVERY_ID,
  created_at: "2026-09-23T18:42:10.000Z",
  updated_at: "2026-09-23T18:42:10.000Z",
};

const shipper = { id: SHIPPER_ID, name: "Distribuidora Paulista" };

const myDelivery = {
  ...deliveryRow,
  shipper,
  items: [deliveryItem],
  stops: [
    {
      id: "0192f7f4-0d1e-7f2a-9b3c-4d5e6f7a8b9c",
      sequence: 2,
      status: "PENDING",
      arrived_at: null,
      // Decision 6.4: the app shows "A caminho desde 13:42".
      on_the_way_at: "2026-09-17T16:42:00.000Z",
      route: {
        id: ROUTE_ID,
        code: 318,
        name: "Campinas — manhã",
        status: "IN_PROGRESS",
        destination: "CD Campinas",
        planned_departure_at: "2026-09-17T10:30:00.000Z",
        planned_arrival_at: "2026-09-17T20:00:00.000Z",
        scheduled_date: "2026-09-17T00:00:00.000Z",
        plan_version: 4,
      },
    },
  ],
  // Decision 6.3: the card shows "Aguardando autorização".
  authorization_request: {
    occurrenceId: "0192f7f7-3a4b-7c5d-8e6f-7a8b9c0d1e2f",
    occurrenceTypeId: "0192f7a0-1e2f-7a3b-8c4d-5e6f7a8b9c0d",
    occurrenceTypeName: "Cliente ausente",
    status: "PENDING",
    note: null,
    decidedAt: null,
    requestedAt: "2026-09-17T14:02:10.000Z",
  },
};

const occurrenceType = {
  id: "0192f7a0-1e2f-7a3b-8c4d-5e6f7a8b9c0d",
  name: "Cliente ausente",
  description: "Ninguém para receber no endereço.",
  requires_photo: true,
  blocks_delivery: true,
  requires_authorization: true,
  form_fields: [
    {
      key: "quem_atendeu",
      label: "Quem atendeu no endereço",
      type: "text",
      required: true,
      max_length: 200,
      multiline: false,
    },
    {
      key: "ligou_cliente",
      label: "Ligou para o cliente",
      type: "boolean",
      required: true,
    },
  ],
  form_version: 1,
  category: "NOT_DELIVERED",
  requires_receipt_photo: false,
  requires_signature: false,
};

const driverPerson = { id: DRIVER_USER_ID, name: "João da Silva" };

const deliveryDetail = {
  ...deliveryRow,
  shipper,
  import: null,
  driver: { id: DRIVER_ID, name: "João da Silva", cnh: "01234567890" },
  vehicle: { id: VEHICLE_ID, license_plate: "ABC1D23" },
  items: [deliveryItem],
  events: [
    {
      id: "0192f7f5-1e2f-7a3b-8c4d-5e6f7a8b9c0e",
      type: "ARRIVAL",
      latitude: -22.9056,
      longitude: -47.0608,
      photo: null,
      signature: null,
      received_by: null,
      actor: "DRIVER_APP",
      device: "android 1.4.0 (42)",
      // Proof fields (decision 14.8): set on a PROOF, null on an arrival.
      device_id: null,
      photo_taken_at: null,
      gps_address: null,
      gps_address_source: null,
      gps_geocoded_at: null,
      note: null,
      status_from: null,
      status_to: null,
      reasonId: null,
      client_submission_id: "0192f7f5-0000-7000-8000-000000000001",
      deliveryId: DELIVERY_ID,
      businessId: BUSINESS_ID,
      routeId: ROUTE_ID,
      occurrenceId: null,
      reportedById: DRIVER_USER_ID,
      occurred_at: "2026-09-24T08:15:02.000Z",
      created_at: "2026-09-24T08:15:32.000Z",
      reportedBy: driverPerson,
      reason: null,
    },
  ],
  occurrences: [],
  chatMessages: [
    {
      id: "0192f7f6-2f3a-7b4c-9d5e-6f7a8b9c0d1e",
      kind: "TEXT",
      body: "Cheguei, a doca lateral está fechada.",
      created_at: "2026-09-24T08:16:40.000Z",
      sender: driverPerson,
    },
  ],
  timeline: [
    {
      id: "0192f7f6-2f3a-7b4c-9d5e-6f7a8b9c0d1e",
      kind: "MESSAGE",
      at: "2026-09-24T08:16:40.000Z",
      title: "Mensagem de João da Silva",
      detail: "Cheguei, a doca lateral está fechada.",
      author: { kind: "USER", name: "João da Silva", device: null },
      photos: [],
      location: null,
      statusFrom: null,
      statusTo: null,
      reason: null,
      blocking: false,
    },
    {
      id: "0192f7f5-1e2f-7a3b-8c4d-5e6f7a8b9c0e",
      kind: "ARRIVAL",
      at: "2026-09-24T08:15:02.000Z",
      title: "Motorista chegou ao endereço",
      detail: null,
      author: {
        kind: "DRIVER_APP",
        name: "João da Silva",
        device: "android 1.4.0 (42)",
      },
      photos: [],
      location: { latitude: -22.9056, longitude: -47.0608 },
      statusFrom: null,
      statusTo: null,
      reason: null,
      blocking: false,
    },
  ],
};

const RESPONSE_EXAMPLES: ResponseExamples = {
  "GET /integration/v1/catalogue": {
    200: buildCatalogue(WEBHOOK_API_VERSION, TOPIC_FAMILY),
  },
  "GET /integration/v1/deliveries": {
    200: { data: [publicDelivery], next_cursor: DELIVERY_ID },
  },
  "GET /integration/v1/deliveries/:id": { 200: publicDelivery },
  "POST /integration/v1/deliveries": {
    201: createdPublicDelivery,
    200: createdPublicDelivery,
  },
  "GET /integration/v1/routes": {
    200: { data: [publicRoute], next_cursor: null },
  },
  "GET /integration/v1/routes/:id": { 200: publicRoute },
  "GET /integration/v1/events": {
    200: { data: publicEvents, next_cursor: publicEvents[1].id },
  },

  "GET /delivery/my-deliveries/:businessId": {
    200: {
      data: [myDelivery],
      // Decision 14.7: the plan the app caches, to notice a change offline.
      routes: [{ id: ROUTE_ID, code: 318, plan_version: 4 }],
      occurrence_types: [occurrenceType],
      // Decision 14.3: proving a delivery is reporting one of these.
      delivered_types: [
        {
          id: "0192f7a0-1e2f-7a3b-8c4d-5e6f7a8b9c0f",
          name: "Entrega normal",
          description:
            "Comprovação padrão: foto do canhoto e assinatura opcional.",
          requires_photo: false,
          blocks_delivery: false,
          requires_authorization: false,
          form_fields: null,
          form_version: 1,
          category: "DELIVERED",
          requires_receipt_photo: true,
          requires_signature: false,
          is_default: true,
        },
      ],
      // Decision 14.4: the pause picker and whether it may open now.
      pause_types: [
        {
          id: "0192f7a0-1e2f-7a3b-8c4d-5e6f7a8b9c10",
          name: "Refeição",
          pause_kind: "MEAL",
          is_default: true,
        },
      ],
      journey: {
        pause_allowed: true,
        route_id: "0192f7a1-2f3a-7b4c-9d5e-6f7a8b9c0d1e",
        day: "2026-10-05",
        time_zone: "America/Sao_Paulo",
      },
    },
  },
  "GET /delivery/get-delivery/:deliveryId/business/:businessId": {
    200: { data: deliveryDetail },
  },
  "POST /delivery/start-route/:businessId": {
    200: { message: "Rota iniciada com sucesso!", data: { started: 12 } },
  },
  "POST /delivery/arrival/:deliveryId/business/:businessId": {
    201: { message: "Chegada registrada com sucesso!" },
  },
  "POST /delivery/proof/:deliveryId/business/:businessId": {
    201: { message: "Entrega comprovada com sucesso!" },
  },
  "POST /delivery/report-occurrence/:deliveryId/business/:businessId": {
    201: {
      message: "Ocorrência registrada. Aguardando autorização da torre.",
      data: {
        id: "0192f7f7-3a4b-7c5d-8e6f-7a8b9c0d1e2f",
        authorization_status: "PENDING",
        replayed: false,
        category: "NOT_DELIVERED",
        delivery_status: "IN_TRANSIT",
        ticket: { id: "0192f7f7-3a4b-7c5d-8e6f-7a8b9c0d1e30", number: 128 },
      },
    },
  },
};

/** The examples for one route, by status; empty when it has none. */
function responseExamplesFor(
  method: string,
  url: string,
): Record<string, unknown> {
  return RESPONSE_EXAMPLES[`${method.toUpperCase()} ${url}`] ?? {};
}

export { RESPONSE_EXAMPLES, responseExamplesFor };
