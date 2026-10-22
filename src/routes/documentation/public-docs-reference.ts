import { env } from "@/env";

import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";
import {
  API_SCOPES,
  BUSINESS_API_RATE_PER_MINUTE,
  KEY_NAMESPACE,
  MAX_ACTIVE_API_KEYS_PER_BUSINESS,
  PLATFORM_API_KEY_RATE_CEILING,
  RESERVED_API_SCOPES,
  SCOPE_DESCRIPTIONS,
  TENANT_API_KEY_RATE_CEILING,
} from "@/shared/integration/api-key-rules";
import {
  INTEGRATION_RATE_WINDOW_SECONDS,
  MAX_API_KEY_AUTH_FAILURES_PER_MINUTE,
} from "@/shared/integration/integration-rate-guard";
import {
  ALL_TOPICS,
  FAMILY_WILDCARDS,
  TOPIC_DESCRIPTIONS,
  TOPIC_FAMILY,
  WEBHOOK_API_VERSION,
} from "@/shared/integration/webhook-catalogue";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  REPLAY_WINDOW_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "@/shared/integration/webhook-dispatch-rules";
import {
  TOPIC_PAYLOAD,
  WEBHOOK_PAYLOAD_SCHEMAS,
} from "@/shared/integration/webhook-payload-schemas";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  SIGNATURE_VERSION,
  WEBHOOK_SECRET_ROTATION_GRACE_MS,
} from "@/shared/integration/webhook-signature";

import { PUBLIC_REQUEST_EXAMPLES } from "./public-docs-examples";

/**
 * The last step of the public reference: the subtracted document made into
 * what a reader and a code generator need.
 *
 * - OpenAPI 3.1, so webhooks are operations (the `webhooks` object) and
 *   renderers show their payload and headers instead of loose schemas. The
 *   zod transformer writes 3.0 `nullable`, which a 3.1 validator refuses, so
 *   every schema is rewritten to `type: [..., "null"]` here.
 * - One tag per resource (Catálogo, Entregas, Rotas, Eventos): the internal
 *   /docs groups all of them under one `integration` tag.
 * - `servers`, so a renderer outside the API knows where to call.
 * - `x-request-id` on every response, which http.ts sends on all of them.
 * - `x-trajetto-*`: the numbers the guides print (limits, retries, the
 *   signature tolerance), read from the constants that enforce them, so the
 *   web portal never copies one by hand.
 * - A real request example on each write (public-docs-examples), which the
 *   zod converter cannot emit.
 *
 * Nothing here invents an endpoint or a field: paths, parameters and bodies
 * come from the routes; this only reshapes and annotates them.
 */
type JsonObject = Record<string, unknown>;

interface PublicDocsOptions {
  /** The API's own public URL (API_HTTP_REQUEST), for `servers`. */
  serverUrl?: string;
  /** The web portal with the guides (the web app's /docs). */
  portalUrl?: string;
  environment?: "development" | "staging" | "production";
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Read per call, so a test can stub the environment. */
function publicDocsOptionsFromEnv(): PublicDocsOptions {
  return {
    serverUrl: env.API_HTTP_REQUEST
      ? withoutTrailingSlash(env.API_HTTP_REQUEST)
      : undefined,
    portalUrl: env.HTTP_REQUEST
      ? `${withoutTrailingSlash(env.HTTP_REQUEST)}/docs`
      : undefined,
    environment: env.APP_ENV,
  };
}

const PUBLIC_PREFIX = "/integration/v1";

/** In the order the portal lists them. */
const RESOURCE_TAGS: Record<string, { name: string; description: string }> = {
  catalogue: {
    name: "Catálogo",
    description:
      "O que esta versão publica: tópicos de webhook, famílias e escopos. Aberto, sem chave.",
  },
  deliveries: {
    name: "Entregas",
    description:
      "Os documentos da empresa dona da chave, com os três identificadores: o id do Trajetto, o código do seu ERP e a chave da NF-e.",
  },
  routes: {
    name: "Rotas",
    description:
      "As rotas da empresa dona da chave, com as paradas na ordem que o despachante escolheu.",
  },
  events: {
    name: "Eventos",
    description:
      "O histórico de eventos das entregas, para quem consulta em vez de receber webhooks.",
  },
};

/** A resource nobody mapped yet; the contract test keeps this empty. */
const OTHER_TAG = {
  name: "Outros",
  description: "Endpoints ainda sem grupo próprio.",
};

function resourceOf(path: string): string {
  return path.slice(PUBLIC_PREFIX.length).split("/")[1] ?? "";
}

function tagFor(path: string): { name: string; description: string } {
  return RESOURCE_TAGS[resourceOf(path)] ?? OTHER_TAG;
}

const REQUEST_ID_HEADER = {
  description:
    "Identificador desta requisição, em toda resposta. Informe-o ao suporte para localizar a chamada nos registros.",
  schema: { type: "string" },
};

const RETRY_AFTER_HEADER = {
  description: "Segundos até poder repetir. Espere pelo menos isso.",
  schema: { type: "integer" },
};

/** Only where the route gave none: @fastify/swagger writes "Default Response". */
const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  "200": "Sucesso.",
  "201": "Criado.",
  "400":
    "Requisição recusada: VALIDATION_ERROR (um campo ou parâmetro inválido; uma frase por campo em `issues`) ou MALFORMED_REQUEST (corpo que não é JSON válido).",
};

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
]);

/**
 * A zod `.describe()` on a response body becomes the response's description
 * AND stays on the body schema; renderers then print the sentence twice.
 */
function withoutEchoedDescription(
  content: unknown,
  description: unknown,
): unknown {
  if (!content || typeof content !== "object") return content;

  return Object.fromEntries(
    Object.entries(content as Record<string, JsonObject>).map(
      ([type, media]) => {
        const schema = media?.schema as JsonObject | undefined;

        if (!schema || schema.description !== description) return [type, media];

        const { description: _echo, ...rest } = schema;

        return [type, { ...media, schema: rest }];
      },
    ),
  );
}

/**
 * The write's real body as `requestBody.content["application/json"].example`
 * (public-docs-examples), so no renderer has to invent one. A route that
 * already publishes its own example keeps it.
 */
function withRequestExample(operation: JsonObject): JsonObject {
  const example = PUBLIC_REQUEST_EXAMPLES[String(operation.operationId)];
  const requestBody = operation.requestBody as
    | { content?: Record<string, JsonObject> }
    | undefined;
  const media = requestBody?.content?.["application/json"];

  if (example === undefined || !media || media.example !== undefined)
    return operation;

  return {
    ...operation,
    requestBody: {
      ...requestBody,
      content: {
        ...requestBody!.content,
        "application/json": { ...media, example },
      },
    },
  };
}

function finishOperation(path: string, operation: JsonObject): JsonObject {
  const responses = Object.fromEntries(
    Object.entries(
      (operation.responses as Record<string, JsonObject>) ?? {},
    ).map(([status, response]) => {
      const headers: JsonObject = {
        ...((response.headers as JsonObject | undefined) ?? {}),
        "x-request-id": REQUEST_ID_HEADER,
      };

      if (status === "503" && !headers["retry-after"]) {
        headers["retry-after"] = RETRY_AFTER_HEADER;
      }

      const description =
        response.description === "Default Response" &&
        DEFAULT_DESCRIPTIONS[status]
          ? DEFAULT_DESCRIPTIONS[status]
          : response.description;

      return [
        status,
        {
          ...response,
          description,
          headers,
          ...(response.content !== undefined && {
            content: withoutEchoedDescription(response.content, description),
          }),
        },
      ];
    }),
  );

  const scopes = operation["x-scopes"];
  const keyed = ((operation.security as JsonObject[] | undefined) ?? []).some(
    (requirement) => "apiKey" in requirement,
  );

  return {
    ...withRequestExample(operation),
    tags: [tagFor(path).name],
    // OpenAPI 3.1 lets a non-OAuth requirement list role names: the scope
    // then shows next to the lock in every renderer.
    ...(keyed && {
      security: [{ apiKey: Array.isArray(scopes) ? [...scopes] : [] }],
    }),
    responses,
  };
}

const WEBHOOK_HEADERS: Array<{ name: string; description: string }> = [
  {
    name: "X-Trajetto-Event-Id",
    description:
      "O id do evento, igual ao `id` do corpo e o mesmo em toda retentativa e todo reenvio. Deduplique por ele.",
  },
  {
    name: "X-Trajetto-Delivery",
    description:
      "A tentativa de entrega. Muda num reenvio manual: serve para falar com o suporte, não para deduplicar.",
  },
  {
    name: "X-Trajetto-Topic",
    description: "O tópico, igual ao `topic` do corpo.",
  },
  {
    name: "X-Trajetto-Signature",
    description: `\`t=<timestamp>,${SIGNATURE_VERSION}=<hex>\`: HMAC SHA-256 de \`<timestamp>.<corpo cru>\` com o segredo inteiro do endpoint, prefixo \`whsec_\` incluído. Recuse um \`t\` com mais de ${SIGNATURE_TOLERANCE_SECONDS} s de diferença do seu relógio. Durante uma troca de segredo vêm dois \`${SIGNATURE_VERSION}\`.`,
  },
];

const FAMILY_LABELS: Record<"route" | "document", string> = {
  route: "rotas",
  document: "documentos",
};

/** Every topic as the request we make, with the headers and the typed data. */
function buildWebhooks(): JsonObject {
  const envelope = WEBHOOK_PAYLOAD_SCHEMAS.WebhookEnvelope as {
    properties: Record<string, JsonObject>;
  };

  return Object.fromEntries(
    ALL_TOPICS.map((topic) => {
      const payload = TOPIC_PAYLOAD[topic];

      return [
        topic,
        {
          post: {
            operationId: `webhook_${topic.replace(/\./g, "_")}`,
            summary: TOPIC_DESCRIPTIONS[topic],
            description: `Tópico \`${topic}\`, da família de ${FAMILY_LABELS[TOPIC_FAMILY[topic]]}. Enviamos um POST ao seu endpoint com o envelope abaixo; \`data\` segue \`${payload}\`. Responda 2xx em até ${WEBHOOK_TIMEOUT_MS / 1000} s.`,
            parameters: WEBHOOK_HEADERS.map((header) => ({
              name: header.name,
              in: "header",
              required: true,
              description: header.description,
              schema: { type: "string" },
            })),
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    ...(WEBHOOK_PAYLOAD_SCHEMAS.WebhookEnvelope as JsonObject),
                    properties: {
                      ...envelope.properties,
                      topic: { ...envelope.properties.topic, enum: [topic] },
                      data: {
                        $ref: `#/components/schemas/${payload}`,
                        description: `O conteúdo do evento, no formato \`${payload}\`.`,
                      },
                    },
                  },
                },
              },
            },
            responses: {
              "2XX": {
                description: `Recebido. Qualquer 2xx em até ${WEBHOOK_TIMEOUT_MS / 1000} s confirma a entrega; o corpo da sua resposta não muda nada.`,
              },
              "410": {
                description:
                  "Gone: desliga o endpoint inteiro, não só este evento. Para recusar um evento isolado, responda 2xx e ignore-o.",
              },
            },
            security: [],
          },
        },
      ];
    }),
  );
}

/** The numbers the web portal's guides print, from the constants that decide them. */
function trajettoExtensions(): JsonObject {
  return {
    "x-trajetto-authentication": {
      header: "Authorization",
      scheme: "Bearer",
      key_format: `${KEY_NAMESPACE}_<prefixo>.<segredo>`,
      max_active_keys_per_business: MAX_ACTIVE_API_KEYS_PER_BUSINESS,
      scopes: API_SCOPES.map((scope) => ({
        scope,
        description: SCOPE_DESCRIPTIONS[scope],
        reserved: RESERVED_API_SCOPES.includes(scope),
      })),
    },
    "x-trajetto-limits": {
      window_seconds: INTEGRATION_RATE_WINDOW_SECONDS,
      key_per_minute_tenant_max: TENANT_API_KEY_RATE_CEILING,
      key_per_minute_platform_max: PLATFORM_API_KEY_RATE_CEILING,
      business_per_minute: BUSINESS_API_RATE_PER_MINUTE,
      invalid_keys_per_address_per_minute: MAX_API_KEY_AUTH_FAILURES_PER_MINUTE,
      service_unavailable_retry_after_seconds: DATABASE_RETRY_AFTER_SECONDS,
    },
    "x-trajetto-webhooks": {
      version: WEBHOOK_API_VERSION,
      timeout_seconds: WEBHOOK_TIMEOUT_MS / 1000,
      retry_delays_seconds: WEBHOOK_RETRY_DELAYS_MS.map(
        (delay) => delay / 1000,
      ),
      max_attempts: WEBHOOK_MAX_ATTEMPTS,
      max_consecutive_failures: MAX_CONSECUTIVE_FAILURES,
      replay_window_days: REPLAY_WINDOW_DAYS,
      max_endpoints_per_business: MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
      headers: WEBHOOK_HEADERS,
      signature: {
        header: "X-Trajetto-Signature",
        algorithm: "HMAC-SHA256",
        version: SIGNATURE_VERSION,
        secret_prefix: "whsec_",
        tolerance_seconds: SIGNATURE_TOLERANCE_SECONDS,
        rotation_grace_hours: WEBHOOK_SECRET_ROTATION_GRACE_MS / 3_600_000,
      },
      families: (["route", "document"] as const).map((family) => ({
        family,
        wildcards: FAMILY_WILDCARDS[family],
      })),
      topics: ALL_TOPICS.map((topic) => ({
        topic,
        family: TOPIC_FAMILY[topic],
        description: TOPIC_DESCRIPTIONS[topic],
        payload: TOPIC_PAYLOAD[topic],
      })),
    },
  };
}

const EXAMPLE_KEYS = new Set(["example", "examples"]);

/**
 * OpenAPI 3.0 schema dialect → 3.1 (JSON Schema 2020-12), recursively:
 * `nullable: true` becomes a `"null"` type (or a null branch), and boolean
 * `exclusiveMinimum`/`exclusiveMaximum` become the numeric bound. Examples
 * are data and are left alone.
 */
function toOpenApi31(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenApi31);
  if (!node || typeof node !== "object") return node;

  const source = node as JsonObject;
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(source)) {
    // Only the keyword: a PROPERTY named "nullable" is an object, not a flag.
    if (key === "nullable" && typeof value === "boolean") continue;

    out[key] = EXAMPLE_KEYS.has(key) ? value : toOpenApi31(value);
  }

  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (typeof out[flag] !== "boolean") continue;

    if (out[flag] === true && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    } else {
      delete out[flag];
    }
  }

  if (source.nullable !== true) return out;

  if (typeof out.$ref === "string") {
    const { $ref, ...rest } = out;

    return { ...rest, anyOf: [{ $ref }, { type: "null" }] };
  }

  if (typeof out.type === "string") {
    out.type = [out.type, "null"];
  } else if (Array.isArray(out.type)) {
    if (!out.type.includes("null")) out.type = [...out.type, "null"];
  } else if (Array.isArray(out.anyOf)) {
    out.anyOf = [...out.anyOf, { type: "null" }];
  } else if (Array.isArray(out.oneOf)) {
    out.oneOf = [...out.oneOf, { type: "null" }];
  }

  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }

  return out;
}

const ENVIRONMENT_LABELS: Record<
  NonNullable<PublicDocsOptions["environment"]>,
  string
> = {
  production: "Produção",
  staging: "Homologação",
  development: "Desenvolvimento",
};

/** The subtracted document, finished for readers and generators. */
function finishPublicDocument(
  document: JsonObject & { paths?: Record<string, Record<string, unknown>> },
  options: PublicDocsOptions,
): JsonObject {
  const paths = Object.fromEntries(
    Object.entries(document.paths ?? {}).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([method, operation]) => [
          method,
          HTTP_METHODS.has(method)
            ? finishOperation(path, operation as JsonObject)
            : operation,
        ]),
      ),
    ]),
  );

  const usedTags = new Set(Object.keys(paths).map((path) => tagFor(path).name));

  const tags = [...Object.values(RESOURCE_TAGS), OTHER_TAG].filter((tag) =>
    usedTags.has(tag.name),
  );

  return toOpenApi31({
    ...document,
    openapi: "3.1.0",

    ...(options.serverUrl && {
      servers: [
        {
          url: options.serverUrl,
          description: ENVIRONMENT_LABELS[options.environment ?? "production"],
        },
      ],
    }),

    ...(options.portalUrl && {
      externalDocs: {
        description: "Guias passo a passo, em português",
        url: options.portalUrl,
      },
    }),

    tags,
    paths,
    webhooks: buildWebhooks(),
    ...trajettoExtensions(),
  }) as JsonObject;
}

export {
  OTHER_TAG,
  RESOURCE_TAGS,
  finishPublicDocument,
  publicDocsOptionsFromEnv,
  toOpenApi31,
  type PublicDocsOptions,
};
