import { z } from "zod";
import { responseDateTime } from "./response-date";

import {
  createApiKeySchema,
  integrationDeliveryListSchema,
  integrationEventListSchema,
  integrationIdParamSchema,
  integrationRouteListSchema,
  listApiUsageSchema,
  listWebhookDeliveriesSchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";
import { DELIVERY_KINDS } from "@/shared/delivery/delivery-kind";

import {
  ALL_TOPICS,
  FAMILY_WILDCARDS,
  TOPIC_DESCRIPTIONS,
} from "@/shared/integration/webhook-catalogue";

import {
  API_SCOPES,
  RESERVED_API_SCOPES,
  SCOPE_DESCRIPTIONS,
} from "@/shared/integration/api-key-rules";

const publicAddress = z.object({
  street: z.string(),
  number: z.string().nullable(),
  complement: z.string().nullable(),
  neighborhood: z.string().nullable(),
  city: z.string(),
  uf: z.string(),
  zip_code: z.string().nullable(),
});

/**
 * The three identifiers every object carries.
 *
 * Our id, the customer's own `code` from their ERP, and the NF-e access key
 * when there is one. An integration that can only match on one of those is an
 * integration that breaks the first time a customer's ERP changes how it
 * numbers things.
 */
const publicDelivery = z.object({
  id: z.string(),
  code: z.string().nullable(),
  invoice_key: z.string().nullable(),
  invoice_number: z.string().nullable(),

  status: z.string(),
  status_label: z.string(),

  kind: z
    .enum(DELIVERY_KINDS)
    .describe(
      "Tipo: DELIVERY (entrega), SERVICE_ORDER (ordem de serviço, ex.: recolher cestos retornáveis) ou PICKUP (coleta).",
    ),

  recipient: z.object({
    name: z.string(),
    document: z.string().nullable(),
    address: publicAddress,
  }),

  // A civil date stored as UTC midnight (decision 1.3). An integrator that
  // converts it to local time reads the day before in Brazil.
  scheduled_date: responseDateTime()
    .nullable()
    .describe(
      "Data prevista, SEM hora: vem como meia-noite UTC do dia (`2026-09-17T00:00:00.000Z` é o dia 17). Leia a parte da data (os 10 primeiros caracteres) ou converta em UTC; convertida para o fuso do Brasil ela vira o dia anterior.",
    ),
  delivered_at: responseDateTime().nullable(),
  received_by: z.string().nullable(),

  proof_url: z
    .string()
    .nullable()
    .describe(
      "Link do comprovante (o PDF), quando a entrega terminou: status DELIVERED ou FAILED. Nulo antes disso e numa entrega cancelada. É um link de PORTADOR: quem o tem abre o comprovante sem login, como quem escaneia o QR impresso nele — guarde-o como guarda o próprio documento e não o exponha a quem não deve ver o canhoto. Abrir o link redireciona (302) para o PDF, gerado na primeira abertura; vale enquanto o comprovante vale (PROOF_VERIFICATION_TTL_DAYS, 5 anos por padrão, contados da criação da entrega) e é o mesmo em toda leitura e em todo webhook da entrega.",
    ),

  route: z.object({ id: z.string(), code: z.number() }).nullable(),

  created_at: responseDateTime(),
  updated_at: responseDateTime(),
});

/**
 * What a cancel answers (L9): the three identifiers and the new status, not
 * the delivery — a cancel-only key was not granted the read.
 */
const publicDeliveryCancellation = z.object({
  id: z.string(),
  code: z.string().nullable(),
  invoice_key: z.string().nullable(),

  status: z.string().describe("Sempre CANCELLED: a entrega está cancelada."),
  status_label: z.string().describe("Sempre `Cancelada`."),

  updated_at: responseDateTime().describe(
    "Quando a entrega mudou pela última vez. Num cancelamento feito agora, é o instante dele; numa repetição, o do cancelamento que já existia.",
  ),
});

const publicRoute = z.object({
  id: z.string(),
  code: z.number(),
  name: z.string().nullable(),

  status: z.string(),

  scheduled_date: responseDateTime().describe(
    "Dia da rota, SEM hora: vem como meia-noite UTC do dia (`2026-09-17T00:00:00.000Z` é o dia 17). Leia a parte da data ou converta em UTC; convertida para o fuso do Brasil ela vira o dia anterior.",
  ),
  destination: z
    .string()
    .nullable()
    .describe("Destino da rota, texto livre, quando foi informado."),
  planned_departure_at: responseDateTime()
    .nullable()
    .describe(
      "Saída prevista (instante em UTC). Nulo quando não foi planejada.",
    ),
  planned_arrival_at: responseDateTime()
    .nullable()
    .describe(
      "Retorno previsto (instante em UTC). Nulo quando não foi planejado.",
    ),
  started_at: responseDateTime().nullable(),
  completed_at: responseDateTime().nullable(),

  driver: z.object({ id: z.string(), name: z.string() }).nullable(),
  vehicle: z.object({ id: z.string(), license_plate: z.string() }).nullable(),

  stops: z.array(
    z.object({
      sequence: z.number(),
      status: z.string(),
      delivery: z.object({
        id: z.string(),
        code: z.string().nullable(),
        invoice_key: z.string().nullable(),
      }),
    }),
  ),

  created_at: responseDateTime(),
});

const cursorPage = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        "Passe em `cursor` para a próxima página. Null significa que acabou.",
      ),
  });

/** `?businessId=`, which only a MASTER sends; the tenant check refuses others. */
const businessQuery = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

const integrationSchemas = {
  businessQuery,

  // One per resource: each status filter is checked against its own enum.
  listDeliveries: integrationDeliveryListSchema,
  listRoutes: integrationRouteListSchema,
  listEvents: integrationEventListSchema,
  idParam: integrationIdParamSchema,

  createApiKey: createApiKeySchema,
  saveWebhookEndpoint: saveWebhookEndpointSchema,
  listWebhookDeliveries: listWebhookDeliveriesSchema,
  listApiUsage: listApiUsageSchema,
};

const integrationResponses = {
  deliveryPage: cursorPage(publicDelivery),
  delivery: publicDelivery,
  deliveryCancellation: publicDeliveryCancellation,

  routePage: cursorPage(publicRoute),
  route: publicRoute,

  eventPage: cursorPage(
    z.object({
      id: z.string(),
      topic: z.string(),
      // The fact's time since MOB-08, no longer the write's: an integrator
      // who treats it as monotonic drops exactly the offline proofs.
      occurred_at: responseDateTime().describe(
        "Quando o fato aconteceu. Para o que o aplicativo do motorista enviou depois, sem sinal, é a hora registrada no aparelho (corrigida pelo relógio do servidor) e pode ser ANTERIOR a eventos já devolvidos em consultas anteriores. `updated_since` filtra pela hora em que o evento chegou ao Trajetto, não por este campo: não descarte um evento por ter `occurred_at` menor que o último visto.",
      ),
      delivery: z.object({
        id: z.string(),
        code: z.string().nullable(),
        invoice_key: z.string().nullable(),
      }),
      // Every key, always present (null when it does not apply): one shape
      // for every topic, as in the webhooks.
      data: z
        .object({
          status_from: z
            .string()
            .nullable()
            .describe(
              "Status da entrega antes do evento, numa mudança de status; nulo nos demais.",
            ),
          status_to: z
            .string()
            .nullable()
            .describe(
              "Status da entrega depois do evento, numa mudança de status; nulo nos demais.",
            ),
          received_by: z
            .string()
            .nullable()
            .describe("Quem recebeu, no comprovante; nulo nos demais."),
          note: z
            .string()
            .nullable()
            .describe("A anotação registrada com o evento, quando houver."),
          occurrence_code: z
            .string()
            .nullable()
            .describe(
              "O código do tipo de ocorrência no seu ERP, em `occurrence.reported` (o mesmo campo do webhook). Nulo nos demais tópicos e quando o tipo não tem código.",
            ),
        })
        .describe(
          "Os mesmos campos em todo tópico; o que não se aplica vem nulo.",
        ),
    }),
  ),

  catalogue: z.object({
    version: z.string(),

    topics: z.array(
      z.object({
        topic: z.string(),
        family: z.enum(["route", "document"]),
        description: z.string(),
      }),
    ),

    families: z
      .array(
        z.object({
          family: z.enum(["route", "document"]),
          wildcards: z.array(z.string()),
        }),
      )
      .describe(
        'O que "todos os eventos" de cada família assina: os curingas de um nível que cobrem os tópicos dela. Documentos são `delivery.*`, `occurrence.*` e `proof.*` — `document.*` não é um curinga válido.',
      ),

    scopes: z.array(
      z.object({
        scope: z.string(),
        description: z.string(),
        reserved: z
          .boolean()
          .describe("Nenhum endpoint da v1 exige este escopo ainda."),
      }),
    ),
  }),

  apiKeyCreated: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      prefix: z.string(),

      token: z
        .string()
        .describe(
          "Mostrado UMA vez. Não é recuperável — uma chave que um painel consegue reexibir é uma chave em todo print e todo chamado de suporte.",
        ),
    }),
  }),

  apiKeyList: z.object({
    message: z.string(),
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        prefix: z.string(),
        scopes: z.array(z.string()),
        rate_limit_per_minute: z.number(),
        last_used_at: responseDateTime().nullable(),
        revoked_at: responseDateTime().nullable(),
        created_at: responseDateTime(),
      }),
    ),
  }),

  webhookEndpointSaved: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      secret: z
        .string()
        .nullable()
        .describe(
          "Só no cadastro e na troca de segredo (`rotate-secret`), uma vez em cada. Nenhuma outra resposta o devolve; na edição vem null.",
        ),
    }),
  }),

  webhookEndpointReactivated: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      reactivated: z
        .boolean()
        .describe("false quando o endpoint não estava desligado por falhas."),
      released: z
        .number()
        .describe("Quantos eventos retidos voltaram para a fila agora."),
    }),
  }),

  webhookEndpointList: z.object({
    message: z.string(),
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        url: z.string(),
        topics: z.array(z.string()),
        is_active: z.boolean(),
        disabled_at: responseDateTime().nullable(),
        consecutive_failures: z.number(),
        created_at: responseDateTime(),
      }),
    ),
  }),

  webhookDeliveryEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),

      searchMeta: z.object({
        window: z
          .enum(["24h", "7d", "30d"])
          .describe("O período que a lista e os contadores cobrem."),
        totalCapped: z
          .boolean()
          .describe(
            "true quando a lista passou do limite de contagem: `total` é então o limite, não a contagem exata. Os contadores abaixo continuam exatos.",
          ),
        delivered: z.number().describe("Eventos do período entregues."),
        failed: z.number().describe("Eventos do período que falharam."),
        pending: z
          .number()
          .describe(
            "A fila inteira (PENDING e PROCESSING), qualquer que seja a idade — o que `status=QUEUED` lista.",
          ),

        p95LatencyMs: z
          .number()
          .nullable()
          .describe(
            "Tempo de resposta do receptor no percentil 95 (nearest-rank) das entregas contadas em `delivered`. Não inclui tempo de fila nem falhas; null quando nada foi entregue no período.",
          ),
      }),
    }),
  }),

  /** One line of that stream, after the envelope: the admin controller's select. */
  webhookDeliveryRow: z.object({
    id: z.string(),
    topic: z.string(),
    status: z.enum(["PENDING", "PROCESSING", "DELIVERED", "FAILED"]),
    attempts: z.number(),
    response_status: z.number().nullable(),
    response_body: z.string().nullable(),
    latency_ms: z.number().nullable(),
    lastError: z.string().nullable(),
    deliveredAt: responseDateTime().nullable(),
    availableAt: responseDateTime().describe("Quando tentamos de novo."),
    leaseExpiresAt: responseDateTime()
      .nullable()
      .describe(
        "Só numa entrega em envio (PROCESSING): até quando a tentativa atual vale. Já vencido, a tentativa morreu com o processo e o despachante vai retomá-la.",
      ),
    created_at: responseDateTime(),
    endpoint: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  }),

  apiUsage: z.object({
    message: z.string(),
    data: z.object({
      totals: z.object({
        ok: z.number(),
        clientError: z.number(),
        serverError: z.number(),
      }),

      byRoute: z.array(
        z.object({
          method: z.string(),
          route: z.string(),
          ok: z.number(),
          clientError: z.number(),
          serverError: z.number(),
        }),
      ),

      byDay: z.array(z.object({ day: z.string(), total: z.number() })),

      keys: z.array(
        z.object({ id: z.string(), name: z.string(), prefix: z.string() }),
      ),

      timeZone: z
        .string()
        .describe(
          'O fuso da empresa (IANA): os dias de `byDay` e o "hoje" são os do calendário dela.',
        ),
    }),
  }),

  resent: z.object({ message: z.string() }),

  webhookTestScheduled: z.object({
    message: z.string(),
    data: z.object({
      id: z
        .string()
        .describe("A linha do teste no monitor de envios (webhook_delivery)."),
      event_id: z
        .string()
        .describe(
          "O id do evento de teste: o `id` do corpo e o `X-Trajetto-Event-Id` que o receptor vê.",
        ),
    }),
  }),

  resendScheduled: z.object({
    message: z.string(),
    data: z.object({
      id: z
        .string()
        .describe("A linha NOVA criada pelo reenvio; a original fica intacta."),
    }),
  }),

  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

/** The catalogue, built from the same constants the dispatcher matches on. */
const buildCatalogue = (version: string, family: Record<string, string>) => ({
  version,
  topics: ALL_TOPICS.map((topic) => ({
    topic,
    family: family[topic] as "route" | "document",
    description: TOPIC_DESCRIPTIONS[topic],
  })),
  families: (["route", "document"] as const).map((name) => ({
    family: name,
    wildcards: FAMILY_WILDCARDS[name],
  })),
  scopes: API_SCOPES.map((scope) => ({
    scope,
    description: SCOPE_DESCRIPTIONS[scope],
    reserved: RESERVED_API_SCOPES.includes(scope),
  })),
});

export { buildCatalogue, integrationSchemas, integrationResponses };
