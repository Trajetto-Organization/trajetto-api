import type { WebhookTopic } from "./webhook-catalogue";

/**
 * What a webhook carries, published next to the endpoints in the public
 * reference.
 *
 * Plain JSON Schema (OpenAPI 3.0 components) and not zod: nothing validates
 * with these, they only describe. The field lists mirror the builders in
 * announce.ts and the call sites that extend them, and the public contract
 * test compares the document and route shapes key by key with the builders,
 * so a field added there and forgotten here fails a test instead of a
 * customer's parser.
 *
 * Adding a field is additive and does not break a subscriber; removing or
 * renaming one is a new API version.
 */
type JsonSchema = Record<string, unknown>;

const nullableString = (description: string): JsonSchema => ({
  type: "string",
  nullable: true,
  description,
});

const documentProperties: Record<string, JsonSchema> = {
  delivery_id: { type: "string", description: "Id da entrega no Trajetto." },
  code: nullableString("O código da entrega no seu ERP."),
  invoice_key: nullableString("Chave de acesso da NF-e, quando houver."),
  invoice_number: nullableString("Número da nota fiscal, quando houver."),
  status: nullableString(
    "Status da entrega depois do evento: PENDING, IN_TRANSIT, DELIVERED, FAILED ou CANCELLED.",
  ),
  recipient_name: nullableString("Nome do destinatário."),
  city: nullableString("Cidade do destino."),
  uf: nullableString("UF do destino."),
  occurred_at: {
    type: "string",
    format: "date-time",
    nullable: true,
    description:
      "Quando o fato aconteceu em campo, nos eventos de um ato registrado em campo: `proof.registered` e o `delivery.delivered` que vem do canhoto (a hora do canhoto), e `occurrence.reported` e o `delivery.failed` de uma ocorrência que impede a entrega (a hora do registro). Pode ser horas anterior ao `created_at` do envelope, que é quando o evento foi gerado: o aparelho guarda o que o motorista fez sem sinal e envia depois. Nulo nos demais eventos, inclusive numa mudança de status feita no painel; neles, vale o `created_at`.",
  },
};

const WEBHOOK_PAYLOAD_SCHEMAS: Record<string, JsonSchema> = {
  WebhookEnvelope: {
    type: "object",
    description:
      "O corpo de todo webhook. Deduplique pelo `id`: a entrega é pelo menos uma vez.",
    required: ["id", "topic", "created_at", "data"],
    properties: {
      id: {
        type: "string",
        description:
          "Id do evento. Igual ao cabeçalho `X-Trajetto-Event-Id` e o mesmo em toda retentativa e todo reenvio manual.",
      },
      sequence: {
        type: "integer",
        description:
          "Crescente, com lacunas, na ordem em que os eventos foram gerados; a mesma em toda retentativa e todo reenvio. A entrega não chega em ordem: aplique um evento só se a `sequence` dele for maior que a do último aplicado ao mesmo documento ou rota. Ausente em eventos gerados antes de existir.",
      },
      topic: { type: "string", description: "O tópico, como no catálogo." },
      created_at: {
        type: "string",
        format: "date-time",
        description: "Quando o evento foi gerado (não quando foi enviado).",
      },
      data: {
        type: "object",
        description:
          "Depende do tópico: veja a tabela de tópicos na introdução.",
      },
    },
  },

  WebhookDocumentData: {
    type: "object",
    description:
      "Os eventos de uma entrega. Traz os três identificadores: o nosso id, o código do seu ERP e a chave da NF-e.",
    properties: documentProperties,
  },

  WebhookAssignmentData: {
    type: "object",
    description: "A entrega foi atribuída a um motorista, dentro de uma rota.",
    properties: {
      ...documentProperties,
      driver_id: { type: "string", description: "Id do motorista." },
      vehicle_id: nullableString("Id do veículo, quando a rota tem um."),
      route_id: { type: "string", description: "Id da rota." },
      route_code: { type: "integer", description: "Número da rota." },
    },
  },

  WebhookOccurrenceData: {
    type: "object",
    description: "Uma ocorrência registrada em campo.",
    properties: {
      ...documentProperties,
      occurrence_type: {
        type: "string",
        description: "O nome do tipo de ocorrência cadastrado pela empresa.",
      },
      blocks_delivery: {
        type: "boolean",
        description:
          "Se a ocorrência impede a entrega (a entrega vai para FAILED).",
      },
      description: nullableString(
        "O que o motorista escreveu, quando escreveu.",
      ),
    },
  },

  WebhookProofAuditData: {
    type: "object",
    description: "O resultado da auditoria do canhoto.",
    properties: {
      delivery_id: { type: "string", description: "Id da entrega." },
      audit_id: { type: "string", description: "Id da auditoria." },
      rejection_reason: nullableString(
        "O motivo, só quando o canhoto foi rejeitado.",
      ),
    },
  },

  WebhookRouteData: {
    type: "object",
    description: "Os eventos de uma rota.",
    properties: {
      route_id: { type: "string", description: "Id da rota." },
      code: { type: "integer", description: "Número da rota." },
      name: nullableString("Nome da rota, quando tem um."),
      status: nullableString(
        "Status da rota depois do evento: PLANNED, RELEASED, IN_PROGRESS, COMPLETED ou CANCELLED.",
      ),
      scheduled_date: {
        type: "string",
        format: "date",
        nullable: true,
        description:
          "O dia da rota, como data civil (AAAA-MM-DD), sem hora e sem fuso: não converta para o seu fuso.",
      },
      destination: nullableString(
        "O destino da rota, texto livre, quando foi informado.",
      ),
      planned_departure_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "A saída prevista, em UTC. Nulo quando não foi planejada.",
      },
      planned_arrival_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "O retorno previsto, em UTC. Nulo quando não foi planejado.",
      },
      driver_id: nullableString("Id do motorista."),
      vehicle_id: nullableString("Id do veículo."),
      started_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "Quando a rota saiu (a hora em que o motorista iniciou). Nulo antes da saída.",
      },
      completed_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "Quando a rota terminou (a hora do fato que resolveu a última parada). Nulo antes do fim.",
      },
      occurred_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "A hora do fato em campo, em `route.started` (a saída) e `route.completed` (o fim). Pode ser horas anterior ao `created_at` do envelope quando o aparelho enviou depois. Nulo nos demais eventos de rota.",
      },
    },
  },
};

/** Which shape each topic's `data` takes. */
const TOPIC_PAYLOAD: Record<
  WebhookTopic,
  keyof typeof WEBHOOK_PAYLOAD_SCHEMAS
> = {
  "route.released": "WebhookRouteData",
  "route.unreleased": "WebhookRouteData",
  "route.started": "WebhookRouteData",
  "route.completed": "WebhookRouteData",
  "route.cancelled": "WebhookRouteData",

  "delivery.created": "WebhookDocumentData",
  "delivery.assigned": "WebhookAssignmentData",
  "delivery.in_transit": "WebhookDocumentData",
  "delivery.delivered": "WebhookDocumentData",
  "delivery.failed": "WebhookDocumentData",
  "delivery.cancelled": "WebhookDocumentData",

  "occurrence.reported": "WebhookOccurrenceData",

  "proof.registered": "WebhookDocumentData",
  "proof.approved": "WebhookProofAuditData",
  "proof.rejected": "WebhookProofAuditData",
};

export { TOPIC_PAYLOAD, WEBHOOK_PAYLOAD_SCHEMAS };
