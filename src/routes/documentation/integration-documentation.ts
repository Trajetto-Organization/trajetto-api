import { z } from "zod";

import {
  createApiKeySchema,
  integrationIdParamSchema,
  integrationListSchema,
  listWebhookDeliveriesSchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";

import {
  ALL_TOPICS,
  TOPIC_DESCRIPTIONS,
} from "@/shared/integration/webhook-catalogue";

import { API_SCOPES, SCOPE_DESCRIPTIONS } from "@/shared/integration/api-key-rules";

const isoDateTime = z.union([z.string(), z.date()]);

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

  recipient: z.object({
    name: z.string(),
    document: z.string().nullable(),
    address: publicAddress,
  }),

  scheduled_date: isoDateTime.nullable(),
  delivered_at: isoDateTime.nullable(),
  received_by: z.string().nullable(),

  route: z.object({ id: z.string(), code: z.number() }).nullable(),

  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const publicRoute = z.object({
  id: z.string(),
  code: z.number(),
  name: z.string().nullable(),

  status: z.string(),

  scheduled_date: isoDateTime,
  started_at: isoDateTime.nullable(),
  completed_at: isoDateTime.nullable(),

  driver: z.object({ id: z.string(), name: z.string() }).nullable(),
  vehicle: z
    .object({ id: z.string(), license_plate: z.string() })
    .nullable(),

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

  created_at: isoDateTime,
});

const cursorPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        "Passe em `cursor` para a próxima página. Null significa que acabou.",
      ),
  });

const integrationSchemas = {
  list: integrationListSchema,
  idParam: integrationIdParamSchema,

  createApiKey: createApiKeySchema,
  saveWebhookEndpoint: saveWebhookEndpointSchema,
  listWebhookDeliveries: listWebhookDeliveriesSchema,
};

const integrationResponses = {
  deliveryPage: cursorPage(publicDelivery),
  delivery: publicDelivery,

  routePage: cursorPage(publicRoute),
  route: publicRoute,

  eventPage: cursorPage(
    z.object({
      id: z.string(),
      topic: z.string(),
      occurred_at: isoDateTime,
      delivery: z.object({
        id: z.string(),
        code: z.string().nullable(),
        invoice_key: z.string().nullable(),
      }),
      data: z.record(z.unknown()),
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

    scopes: z.array(
      z.object({ scope: z.string(), description: z.string() }),
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
        last_used_at: isoDateTime.nullable(),
        revoked_at: isoDateTime.nullable(),
        created_at: isoDateTime,
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
          "Só no cadastro, e só uma vez. Depois disso o segredo não é mais legível por ninguém.",
        ),
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
        disabled_at: isoDateTime.nullable(),
        consecutive_failures: z.number(),
        created_at: isoDateTime,
      }),
    ),
  }),

  webhookDeliveryEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),

      searchMeta: z.object({
        delivered: z.number(),
        failed: z.number(),
        pending: z.number(),

        p95LatencyMs: z
          .number()
          .nullable()
          .describe("Sobre as entregues nas últimas 24h."),
      }),
    }),
  }),

  resent: z.object({ message: z.string() }),

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
  scopes: API_SCOPES.map((scope) => ({
    scope,
    description: SCOPE_DESCRIPTIONS[scope],
  })),
});

export { buildCatalogue, integrationSchemas, integrationResponses };
