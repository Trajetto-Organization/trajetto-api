import type { FastifySchema, RouteOptions } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { z, type ZodTypeAny } from "zod";

import { ensureApiKey } from "@/modules/middlewares/ensure-api-key";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import { isUpgradeExempt } from "@/shared/http/client-version";
import { MAX_API_KEY_AUTH_FAILURES_PER_MINUTE } from "@/shared/integration/integration-rate-guard";
import { BUSINESS_API_RATE_PER_MINUTE } from "@/shared/integration/api-key-rules";
import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";

import { ndjsonDocFor, type NdjsonDoc } from "./ndjson";
import {
  documentedDocFor,
  fileDocFor,
  type FileDoc,
} from "./doc-only-responses";
import { responseExamplesFor } from "./response-examples";
import { normalizeTagName } from "./api-tags";

/**
 * The OpenAPI document, completed from what the routes actually run.
 *
 * The zod schemas describe bodies well, but every refusal that comes from a
 * HOOK — the session check, the permission and role gates, the module gate,
 * the rate limiter — was written by hand on each route, when it was written at
 * all: 0 of 218 session routes documented 401, none documented 503, and 11 of
 * 239 documented 429. A client generated from /docs could not tell a transient
 * 503 from a logout, or retry a revoked account forever.
 *
 * So the statuses are derived here, from the hooks themselves, and a route
 * cannot forget them. A status the route already documents keeps its own
 * schema; only its description is completed. Documentation only: nothing in
 * this file runs on a request.
 */
type JsonSchema = Record<string, unknown>;

interface TransformInput {
  schema: FastifySchema;
  url: string;
  route: RouteOptions;
}

/** What a guard factory attaches to the hook it returns. */
interface GuardDoc {
  permission?: { key: string; access: "read" | "write" };
  /** Either of these grants (verifyAnyPermission / anyPermissionDoc). */
  anyOf?: Array<{ key: string; access: "read" | "write" }>;
  roles?: string[];
  module?: string;
  /** The API-key scope `verifyApiScope` demands. */
  scope?: string;
}

const MODULE_NAMES: Record<string, string> = {
  FLEET: "Frota",
  DELIVERIES: "Entregas",
};

const SESSION_401_CODES = [
  "AUTH_TOKEN_MISSING",
  "AUTH_TOKEN_INVALID",
  "AUTH_SESSION_INVALID",
  "AUTH_SESSION_INVALIDATED",
];

const SESSION_403_CODES = [
  "AUTH_ACCESS_REVOKED",
  "AUTH_BUSINESS_REQUIRED",
  "AUTH_BUSINESS_INACTIVE",
  "AUTH_DRIVER_INACTIVE",
  "AUTH_DRIVER_TENANT_MISMATCH",
  "AUTH_BRANCH_INACTIVE",
  "AUTH_PROFILE_NOT_CONFIGURED",
  "TENANT_ACCESS_DENIED",
];

const ERROR_CODE_HEADER: JsonSchema = {
  type: "string",
  description:
    "O mesmo `code` do corpo, para quem decide sem ler o JSON (erros de negócio e de guarda).",
};

const RATE_LIMIT_HEADERS: Record<string, JsonSchema> = {
  "retry-after": {
    type: "integer",
    description: "Segundos até poder repetir. Espere pelo menos isso.",
  },
  "x-ratelimit-limit": {
    type: "integer",
    description: "Requisições permitidas na janela.",
  },
  "x-ratelimit-remaining": {
    type: "integer",
    description: "Quantas ainda restam na janela atual.",
  },
  "x-ratelimit-reset": {
    type: "integer",
    description: "Segundos até a janela recomeçar.",
  },
};

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];

  return Array.isArray(value) ? value : [value];
}

/**
 * @fastify/swagger reads a response's description from this key and removes
 * it from the body schema; a plain `description` would be printed twice, once
 * per status and once inside the schema, on each of ~220 routes.
 */
const RESPONSE_DESCRIPTION = "x-response-description";

function descriptionOf(response: JsonSchema): string {
  const value = response[RESPONSE_DESCRIPTION] ?? response.description;

  return typeof value === "string" ? value : "";
}

function errorBody(
  description: string,
  codes: string[],
  headers: Record<string, JsonSchema> = {},
): JsonSchema {
  return {
    [RESPONSE_DESCRIPTION]: description,
    type: "object",
    properties: {
      code: {
        type: "string",
        description: `Um destes: ${codes.join(", ")}.`,
        example: codes[0],
      },
      message: {
        type: "string",
        description: "Frase em português, pronta para mostrar a quem usa.",
      },
    },
    required: ["code", "message"],
    // Copied per response: @fastify/swagger deletes `description` from the
    // header schema it is handed, so a shared object would lose it after the
    // first route.
    headers: Object.fromEntries(
      Object.entries({ "x-error-code": ERROR_CODE_HEADER, ...headers }).map(
        ([name, header]) => [name, { ...header }],
      ),
    ),
  };
}

/**
 * The upgrade gate's refusal (shared/http/client-version.ts).
 *
 * A global hook, so no route declares it, yet it can answer any of them: an
 * app build that sends x-trajetto-client-version with a contract below
 * MIN_MOBILE_CONTRACT. The body carries two fields beyond the usual pair, and
 * they are what the app acts on — an update, or the store page.
 */
function upgradeRequiredBody(): JsonSchema {
  const body = errorBody(
    "CLIENT_UPGRADE_REQUIRED: esta versão do app do motorista não é mais aceita. Só acontece com quem envia o cabeçalho `x-trajetto-client-version` com `contract` abaixo do mínimo configurado (MIN_MOBILE_CONTRACT, desligado por padrão); a web e clientes sem esse cabeçalho nunca recebem. Repetir não muda a resposta: o app precisa ser atualizado — pela atualização over-the-air do runtime, quando houver, ou pela loja em `storeUrl`.",
    ["CLIENT_UPGRADE_REQUIRED"],
  );

  return {
    ...body,
    properties: {
      ...(body.properties as JsonSchema),
      minContract: {
        type: "integer",
        description: "O menor `contract` que a API aceita hoje.",
      },
      storeUrl: {
        type: "string",
        format: "uri",
        description:
          "Página da loja para atualizar o app (MOBILE_STORE_URL). Ausente quando não configurada.",
      },
    },
  };
}

/**
 * Adds a response the route does not document, or completes the description
 * of one it does. The route's own schema always wins: it is what the
 * serializer validates.
 */
function mergeResponse(
  responses: Record<string, JsonSchema>,
  status: string,
  generated: JsonSchema,
): void {
  const existing = responses[status];

  if (!existing) {
    responses[status] = generated;
    return;
  }

  const own = descriptionOf(existing);
  const extra = descriptionOf(generated);

  // The codes the hooks produce join the ones the route lists, so the
  // rebuilt schema (canonicalizeErrorResponses) names both.
  const ownCodes = codeDescriptionOf(existing);
  const hookCodes = codeDescriptionOf(generated);
  const properties = existing.properties as JsonSchema | undefined;
  const codes =
    ownCodes && hookCodes && ownCodes !== hookCodes
      ? `${ownCodes} ${hookCodes}`
      : (ownCodes ?? hookCodes);

  responses[status] = {
    ...existing,
    ...(properties && codes
      ? {
          properties: {
            ...properties,
            code: { ...((properties.code as JsonSchema) ?? {}), type: "string", description: codes },
          },
        }
      : {}),
    [RESPONSE_DESCRIPTION]: own && !own.includes(extra) ? `${own} ${extra}` : own || extra,
    headers: {
      ...(generated.headers as JsonSchema | undefined),
      ...(existing.headers as JsonSchema | undefined),
    },
  };
}

const WINDOW_UNITS: Record<string, string> = {
  second: "segundo",
  minute: "minuto",
  hour: "hora",
};

function describeWindow(timeWindow: unknown): string {
  if (typeof timeWindow === "number") {
    const seconds = Math.round(timeWindow / 1000);

    if (seconds % 60 === 0) {
      const minutes = seconds / 60;

      return minutes === 1 ? "minuto" : `${minutes} minutos`;
    }

    return seconds === 1 ? "segundo" : `${seconds} segundos`;
  }

  const match = /^(\d+)\s*(second|minute|hour)s?$/.exec(String(timeWindow));

  if (!match) return String(timeWindow);

  const amount = Number(match[1]);
  const unit = WINDOW_UNITS[match[2]];

  return amount === 1 ? unit : `${amount} ${unit}s`;
}

function describeRateLimit(rateLimit: unknown): string {
  if (!rateLimit || typeof rateLimit !== "object") {
    return "Vale o limite global, contado por usuário (ou por endereço, antes do login).";
  }

  const { max, timeWindow } = rateLimit as { max?: unknown; timeWindow?: unknown };

  const amount =
    typeof max === "number" ? String(max) : "o teto configurado na credencial";

  return `Limite desta rota: ${amount} por ${describeWindow(timeWindow ?? 60_000)}.`;
}

function guardsOf(route: RouteOptions): GuardDoc[] {
  return toArray(route.preHandler)
    .map((hook) => (hook as { openapi?: GuardDoc } | null)?.openapi)
    .filter((doc): doc is GuardDoc => doc !== undefined);
}

/** A zod schema as the JSON Schema the rest of the document is made of. */
function toJsonSchema(schema: ZodTypeAny, url: string): JsonSchema {
  const converted = jsonSchemaTransform({
    schema: { response: { 200: schema } } as FastifySchema,
    url,
  }) as { schema: { response: Record<string, JsonSchema> } };

  return converted.schema.response["200"];
}

function fileResponse(doc: FileDoc): JsonSchema {
  return {
    [RESPONSE_DESCRIPTION]: doc.description,
    content: Object.fromEntries(
      doc.contentTypes.map((type) => [
        type,
        { schema: { type: "string", format: "binary" } },
      ]),
    ),
    headers: {
      "content-disposition": {
        type: "string",
        description: `attachment; filename="${doc.filename}".`,
      },
    },
  };
}

/**
 * A streamed line has AT LEAST the fields its item lists, never only those.
 *
 * zod renders every object as `additionalProperties: false`, which is true of
 * a JSON body: the serializer cuts it down to its schema. A stream has no
 * serializer, and most listings select the whole row, so on a line it would
 * be false — a validator built from /docs would reject real lines for
 * carrying a column the item does not name. Mutates the fresh conversion.
 */
function openEnded(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;

  const node = schema as JsonSchema;

  if (node.additionalProperties === false) delete node.additionalProperties;

  for (const child of Object.values((node.properties ?? {}) as JsonSchema)) {
    openEnded(child);
  }

  openEnded(node.items);

  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    for (const member of (node[combinator] ?? []) as unknown[]) {
      openEnded(member);
    }
  }
}

function ndjsonResponse(doc: NdjsonDoc, url: string): JsonSchema {
  const item = toJsonSchema(doc.item.describe("Cada linha seguinte: um item."), url);

  openEnded(item);

  const lines = [
    "Corpo `application/x-ndjson`: um JSON por linha, não um documento. A primeira linha é `{\"meta\": …}`; cada linha seguinte é um item. Leia linha a linha — `JSON.parse` no corpo inteiro falha. Com `Accept-Encoding: gzip`, vem comprimido.",
  ];

  if (doc.cursor) {
    lines.push(
      "Próxima página: repita a chamada com `cursor` = `meta.searchMeta.nextCursor` enquanto `meta.searchMeta.hasMore` for true.",
    );
  }

  return {
    [RESPONSE_DESCRIPTION]: lines.join(" "),
    content: {
      "application/x-ndjson": {
        schema: {
          oneOf: [
            toJsonSchema(
              z
                .object({ meta: doc.meta })
                .describe("Primeira linha: os metadados da página."),
              url,
            ),
            item,
          ],
        },
      },
    },
  };
}

/**
 * The body and headers some controllers parse by hand.
 *
 * The fueling and checklist writes normalise form fields and copy the
 * Idempotency-Key header into the body before validating, so a real
 * `schema.body` would refuse what those controllers accept, and a
 * `schema.headers` would replace `request.headers`. `config.openapi` carries
 * the same zod schemas for the document only, and never overrides a schema
 * the route really validates with.
 */
function withDocumentedInputs(
  schema: FastifySchema,
  route: RouteOptions,
): FastifySchema {
  const documented = (route.config as { openapi?: { body?: unknown; headers?: unknown } } | undefined)
    ?.openapi;

  if (!schema || !documented) return schema;

  return {
    ...schema,
    ...(documented.body && !schema.body ? { body: documented.body } : {}),
    ...(documented.headers && !schema.headers
      ? { headers: documented.headers }
      : {}),
  };
}

/**
 * The published error schemas are the bodies the API really sends.
 *
 * Each route used to declare its own error shapes: `{ message }` closed with
 * `additionalProperties: false` on 182 routes' 500 (the handler sends `code`,
 * `status` and `requestId` too), `{ message }` on 4xx that the runtime sends
 * with `code`, `issues` on statuses that never carry it. A client generated
 * from the document with strict validation rejected the real body. So every
 * status >= 400 is rebuilt here from the error handler's shapes (http.ts),
 * keeping what the route says about it: its description, its headers and the
 * extra detail fields some refusals carry (a 409 that says who decided).
 */
const HANDLER_FIELDS = new Set(["code", "message", "issues", "status", "requestId"]);

const MESSAGE_PROPERTY: JsonSchema = {
  type: "string",
  description: "Frase em português, pronta para mostrar a quem usa.",
};

const REQUEST_ID_PROPERTY: JsonSchema = {
  type: "string",
  description:
    "O mesmo valor do cabeçalho `x-request-id`: informe-o ao suporte para localizar a falha.",
};

const RETRY_AFTER_HEADER: JsonSchema = {
  type: "integer",
  description: "Segundos até poder repetir. Espere pelo menos isso.",
};

function codeDescriptionOf(response: JsonSchema): string | undefined {
  const code = (response.properties as JsonSchema | undefined)?.code as
    | JsonSchema
    | undefined;

  if (!code) return undefined;

  if (typeof code.description === "string") return code.description;

  return Array.isArray(code.enum) ? `Um destes: ${code.enum.join(", ")}.` : undefined;
}

/** Detail fields a route's refusal carries beyond the handler's; all optional. */
function extraPropertiesOf(response: JsonSchema): JsonSchema {
  const properties = (response.properties ?? {}) as JsonSchema;

  return Object.fromEntries(
    Object.entries(properties).filter(([name]) => !HANDLER_FIELDS.has(name)),
  );
}

function withHeaders(
  response: JsonSchema,
  added: Record<string, JsonSchema>,
): JsonSchema {
  return Object.fromEntries(
    Object.entries({ ...added, ...((response.headers as JsonSchema) ?? {}) }).map(
      ([name, header]) => [name, { ...(header as JsonSchema) }],
    ),
  );
}

/** Keeps what the route said about the status: description and headers. */
function describedLike(response: JsonSchema): JsonSchema {
  return Object.fromEntries(
    [RESPONSE_DESCRIPTION, "description"]
      .filter((key) => typeof response[key] === "string")
      .map((key) => [key, response[key]]),
  );
}

function clientErrorSchema(status: number, response: JsonSchema): JsonSchema {
  const codeDescription =
    codeDescriptionOf(response) ??
    "Código estável para o cliente decidir; também no cabeçalho `x-error-code`.";

  // What the route says about the message and the issues stays (the 400 of
  // a read explains that VALIDATION_ERROR's message is a fixed English text);
  // only the shape is the handler's.
  const own = (response.properties ?? {}) as Record<string, JsonSchema>;
  const ownMessage = own.message?.type === "string" ? own.message : undefined;
  const ownIssues = own.issues?.type === "array" ? own.issues : undefined;

  return {
    ...describedLike(response),
    type: "object",
    properties: {
      code: { type: "string", description: codeDescription },
      message: ownMessage ?? MESSAGE_PROPERTY,
      ...(status === 400
        ? {
            issues: ownIssues ?? {
              type: "array",
              items: { type: "string" },
              description:
                "Só em VALIDATION_ERROR: uma frase por campo ou parâmetro recusado.",
            },
          }
        : {}),
      ...extraPropertiesOf(response),
    },
    required: ["code", "message"],
    additionalProperties: false,
    headers: withHeaders(response, { "x-error-code": ERROR_CODE_HEADER }),
  };
}

function internalErrorSchema(response: JsonSchema): JsonSchema {
  return {
    ...describedLike(response),
    [RESPONSE_DESCRIPTION]:
      descriptionOf(response) ||
      "INTERNAL_ERROR: falha nossa. Repetir com espera pode funcionar; se persistir, envie o `requestId` ao suporte.",
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "INTERNAL_ERROR, ou o código de uma falha conhecida e já registrada por nós.",
      },
      status: { type: "string", enum: ["error"] },
      message:
        (response.properties as Record<string, JsonSchema> | undefined)?.message?.description
          ? (response.properties as Record<string, JsonSchema>).message
          : {
              type: "string",
              description:
                "`Internal server error` numa falha inesperada (sem detalhes dela); numa falha conhecida, a frase dela em português.",
            },
      requestId: REQUEST_ID_PROPERTY,
    },
    required: ["code", "status", "message", "requestId"],
    additionalProperties: false,
  };
}

function unavailableSchema(response: JsonSchema): JsonSchema {
  const own = (response.properties as JsonSchema | undefined)?.code as
    | JsonSchema
    | undefined;
  // A route that can only be refused by the database outage (the keyed
  // routes) says so with an enum and a required requestId; both stay.
  const requiresRequestId =
    Array.isArray(response.required) && response.required.includes("requestId");

  return {
    ...describedLike(response),
    type: "object",
    properties: {
      code: {
        type: "string",
        ...(Array.isArray(own?.enum) ? { enum: own.enum } : {}),
        description:
          codeDescriptionOf(response) ??
          "SERVICE_UNAVAILABLE (banco indisponível) ou o código da dependência que caiu.",
      },
      message: MESSAGE_PROPERTY,
      requestId: {
        ...REQUEST_ID_PROPERTY,
        description: "Só em SERVICE_UNAVAILABLE: o mesmo valor do cabeçalho `x-request-id`.",
      },
    },
    required: ["code", "message", ...(requiresRequestId ? ["requestId"] : [])],
    additionalProperties: false,
    headers: withHeaders(response, {
      "x-error-code": ERROR_CODE_HEADER,
      "retry-after": RETRY_AFTER_HEADER,
    }),
  };
}

/**
 * A 503 the route builds itself (the readiness probe) has its own shape and
 * no `code`; only the handler's 503 is rebuilt.
 */
function isHandlerUnavailable(response: JsonSchema): boolean {
  const properties = response.properties as JsonSchema | undefined;

  return !properties || "code" in properties;
}

function canonicalizeErrorResponses(responses: Record<string, JsonSchema>): void {
  for (const [status, response] of Object.entries(responses)) {
    const code = Number(status);

    // A file or stream marker is never an error body.
    if (!(code >= 400) || response.content) continue;

    if (code < 500) responses[status] = clientErrorSchema(code, response);
    else if (code === 500) responses[status] = internalErrorSchema(response);
    else if (code === 503 && isHandlerUnavailable(response)) {
      responses[status] = unavailableSchema(response);
    }
  }
}

function appendDescription(schema: JsonSchema, lines: string[]): void {
  if (lines.length === 0) return;

  const own = typeof schema.description === "string" ? schema.description : "";

  schema.description = [own, ...lines].filter(Boolean).join("\n\n");
}

function openapiTransform(input: TransformInput): {
  schema: FastifySchema;
  url: string;
} {
  const { route, url } = input;

  const result = jsonSchemaTransform({
    schema: withDocumentedInputs(input.schema, route),
    url,
  }) as {
    schema: JsonSchema & { hide?: boolean; response?: Record<string, JsonSchema> };
    url: string;
  };

  const schema = result.schema;

  if (!schema || schema.hide) return result as { schema: FastifySchema; url: string };

  // One spelling per section, whatever the route file wrote (api-tags.ts).
  if (Array.isArray(schema.tags)) {
    schema.tags = (schema.tags as string[]).map(normalizeTagName);
  }

  // A route with no response map is left to the generator's placeholder, so
  // the contract test still sees it as undescribed instead of as a route that
  // only ever fails.
  const responses = schema.response;

  if (!responses) return result as { schema: FastifySchema; url: string };

  // Some declared schemas are markers, not shapes: a streamed listing, a
  // file, or a pass-through body documented with its typed shape.
  const declared = (input.schema.response ?? {}) as Record<string, unknown>;

  for (const [status, runtime] of Object.entries(declared)) {
    const ndjson = ndjsonDocFor(runtime);
    const file = fileDocFor(runtime);
    const documented = documentedDocFor(runtime);

    if (ndjson) responses[status] = ndjsonResponse(ndjson, url);
    else if (file) responses[status] = fileResponse(file);
    else if (documented) responses[status] = toJsonSchema(documented, url);
  }

  // Example success bodies (response-examples.ts). A one-element JSON Schema
  // `examples` is what @fastify/swagger turns into the media type's
  // `example`; the serializer never sees this object.
  for (const [status, example] of Object.entries(
    responseExamplesFor(String(route.method), route.url),
  )) {
    if (responses[status]) responses[status].examples = [example];
  }

  const onRequest = toArray(route.onRequest);
  const preHandler = toArray(route.preHandler);
  const guards = guardsOf(route);

  const businessGate = preHandler.includes(verifyBusinessActive);
  const branchGate = preHandler.includes(verifyBranchActive);

  const config = (route.config ?? {}) as {
    rateLimit?: unknown;
    openapi?: { module?: string };
  };

  const permissions = guards.flatMap((guard) =>
    guard.permission ? [guard.permission] : [],
  );
  // Each guard with alternatives is one "any of" group; x-permissions stays
  // "all of", which is how clients already read it.
  const alternatives = guards.flatMap((guard) =>
    guard.anyOf && guard.anyOf.length > 0 ? [guard.anyOf] : [],
  );
  const roles = guards.flatMap((guard) => guard.roles ?? []);
  const scopes = guards.flatMap((guard) => (guard.scope ? [guard.scope] : []));

  const accessLabel = ({ key, access }: { key: string; access: string }) =>
    `\`${key}\` (${access === "write" ? "escrita" : "leitura"})`;
  const modules = [
    ...guards.flatMap((guard) => (guard.module ? [guard.module] : [])),
    ...(config.openapi?.module ? [config.openapi.module] : []),
  ];

  // The MASTER's module gate looks up every company a request names, so it
  // can answer TENANT_NOT_FOUND or TENANT_INACTIVE — only where a company
  // can be named at all.
  const masterCompanyLookup =
    modules.length > 0 &&
    (["params", "querystring", "body"] as const).some((part) => {
      const properties = (schema[part] as JsonSchema | undefined)?.properties as
        | JsonSchema
        | undefined;

      return Boolean(properties?.businessId);
    });

  const notes: string[] = [];

  if (permissions.length > 0) {
    schema["x-permissions"] = permissions;

    notes.push(
      `Permissão exigida: ${permissions
        .map(accessLabel)
        .join(", ")}. MASTER e BUSINESS_ADMIN passam sempre; o motorista, só nas permissões do app.`,
    );
  }

  if (alternatives.length > 0) {
    schema["x-permissions-any"] = alternatives;

    notes.push(
      `Permissão exigida: ${alternatives
        .map((group) => `uma entre ${group.map(accessLabel).join(" ou ")}`)
        .join("; e ")}. MASTER e BUSINESS_ADMIN passam sempre; o motorista, só nas permissões do app.`,
    );
  }

  // Published from the hook itself, so the document cannot name a scope
  // the route does not check (or miss one it does).
  if (scopes.length > 0) {
    schema["x-scopes"] = scopes;
    notes.push(
      `Escopo exigido da chave de API: ${scopes.map((scope) => `\`${scope}\``).join(", ")}. Sem ele, 403 MISSING_API_SCOPE.`,
    );
  }

  if (roles.length > 0) {
    schema["x-roles"] = roles;
    notes.push(`Restrita aos papéis: ${roles.join(", ")}.`);
  }

  if (modules.length > 0) {
    schema["x-module"] = modules[0];
    notes.push(
      `Exige o módulo ${modules[0]} (${MODULE_NAMES[modules[0]] ?? modules[0]}) contratado pela empresa. Vale também para o MASTER, conferido em cada empresa que a requisição informa.`,
    );
  }

  if (onRequest.includes(ensureAuthenticated)) {
    mergeResponse(
      responses,
      "401",
      errorBody(
        "Sem sessão válida. AUTH_TOKEN_MISSING ou AUTH_TOKEN_INVALID: token ausente, inválido ou expirado — renove com POST /user/refresh-token e repita uma vez. AUTH_SESSION_INVALID ou AUTH_SESSION_INVALIDATED: a sessão foi encerrada (logout, troca de senha, revogação) — peça login de novo.",
        SESSION_401_CODES,
      ),
    );

    const forbiddenCodes = [...SESSION_403_CODES];
    const forbiddenReasons = [
      "Sessão válida, acesso recusado; repetir não muda a resposta.",
      "AUTH_ACCESS_REVOKED, AUTH_BUSINESS_REQUIRED, AUTH_BUSINESS_INACTIVE, AUTH_DRIVER_INACTIVE, AUTH_DRIVER_TENANT_MISMATCH, AUTH_BRANCH_INACTIVE ou AUTH_PROFILE_NOT_CONFIGURED: a conta, a empresa, a filial ou o motorista estão bloqueados.",
      "TENANT_ACCESS_DENIED: a requisição nomeia outra empresa.",
    ];

    if (roles.length > 0) {
      forbiddenCodes.push("AUTH_ROLE_FORBIDDEN");
      forbiddenReasons.push(`AUTH_ROLE_FORBIDDEN: rota só para ${roles.join(", ")}.`);
    }

    if (permissions.length > 0 || alternatives.length > 0) {
      forbiddenCodes.push("PERMISSION_DENIED");
      forbiddenReasons.push(
        "PERMISSION_DENIED: o perfil de acesso não tem a permissão exigida (leitura ou escrita), ou o token é de motorista e a rota não faz parte do que o motorista pode fazer.",
      );
    }

    if (modules.length > 0) {
      forbiddenCodes.push("MODULE_NOT_ENABLED");
      forbiddenReasons.push(
        "MODULE_NOT_ENABLED: a empresa não contratou o módulo desta rota. Vale também para o MASTER, conferido em cada empresa que a requisição informa.",
      );
    }

    // The MASTER's module gate looks the company up first, so a switched-off
    // company without the module is refused as switched off.
    if (businessGate || masterCompanyLookup) {
      forbiddenCodes.push("TENANT_INACTIVE");
      forbiddenReasons.push(
        businessGate
          ? "TENANT_INACTIVE: a empresa informada está desativada."
          : "TENANT_INACTIVE: o MASTER informou uma empresa desativada que não tem o módulo.",
      );
    }

    if (branchGate) {
      forbiddenCodes.push("BRANCH_INACTIVE");
      forbiddenReasons.push("BRANCH_INACTIVE: a filial informada está desativada.");
    }

    mergeResponse(
      responses,
      "403",
      errorBody(forbiddenReasons.join(" "), forbiddenCodes),
    );

    // The tenant gates look the company and the branch up before the handler
    // runs, so an id that does not exist is refused there; so does the
    // MASTER's module gate, for every company the request names.
    if (businessGate || branchGate || masterCompanyLookup) {
      const notFound = [
        ...(businessGate || masterCompanyLookup ? ["TENANT_NOT_FOUND"] : []),
        ...(branchGate ? ["BRANCH_NOT_FOUND"] : []),
      ];

      mergeResponse(
        responses,
        "404",
        errorBody(
          `${notFound.join(" ou ")}: a empresa ou a filial informada não existe.${
            branchGate
              ? " Uma filial de outra empresa recebe a mesma resposta, para não revelar quais filiais existem."
              : ""
          }`,
          notFound,
        ),
      );
    }

    mergeResponse(
      responses,
      "503",
      errorBody(
        "AUTH_SESSION_UNAVAILABLE: não foi possível verificar a sessão agora (banco indisponível). SERVICE_UNAVAILABLE: o banco caiu depois da sessão conferida (traz `requestId`). Transitório: espere o `retry-after` e repita; numa escrita, com o mesmo `Idempotency-Key`. NÃO é logout — não descarte a sessão.",
        ["AUTH_SESSION_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
        { "retry-after": RETRY_AFTER_HEADER },
      ),
    );

    // Documented where the app lives, the routes behind a session, minus the
    // ones the gate lets through so an old build can keep and end a session.
    if (!isUpgradeExempt(String(route.method).toUpperCase(), route.url)) {
      mergeResponse(responses, "426", upgradeRequiredBody());
    }
  }

  if (onRequest.includes(ensureApiKey)) {
    mergeResponse(
      responses,
      "401",
      errorBody(
        "INVALID_API_KEY: chave ausente, malformada, desconhecida ou revogada — de propósito, não dizemos qual. Confira a credencial; repetir não ajuda.",
        ["INVALID_API_KEY"],
      ),
    );

    mergeResponse(
      responses,
      "403",
      errorBody(
        "Chave válida, acesso recusado. TENANT_INACTIVE: a empresa da chave está desativada. MODULE_NOT_ENABLED: a empresa não tem o módulo Entregas. MISSING_API_SCOPE: a chave não tem o escopo desta rota.",
        ["MISSING_API_SCOPE", "TENANT_INACTIVE", "MODULE_NOT_ENABLED"],
      ),
    );

    // Not read from `config.rateLimit`: the key's ceiling is ONE limiter the
    // v1 routes share (integration-routes.ts), so they opt out of the
    // plugin's per-route hook with `rateLimit: false`, and the check below
    // would take that for "no limit". ensureApiKey itself also answers 429
    // to an address that keeps presenting invalid keys.
    mergeResponse(
      responses,
      "429",
      errorBody(
        `RATE_LIMITED: acabou o teto por minuto da chave (\`rate_limit_per_minute\`), que é um só para todas as rotas /integration/v1 somadas; ou a empresa da chave passou de ${BUSINESS_API_RATE_PER_MINUTE} requisições no minuto, somadas entre todas as chaves dela (essa recusa traz só \`retry-after\`, sem os cabeçalhos \`x-ratelimit-*\`); ou este endereço apresentou ${MAX_API_KEY_AUTH_FAILURES_PER_MINUTE} chaves inválidas no último minuto. Espere o tempo de \`retry-after\` antes de repetir.`,
        ["RATE_LIMITED"],
        RATE_LIMIT_HEADERS,
      ),
    );

    // The key is looked up in the database before anything else runs, so an
    // outage answers here, with Retry-After, on every keyed route.
    mergeResponse(
      responses,
      "503",
      errorBody(
        `SERVICE_UNAVAILABLE: o banco de dados está indisponível por instantes. Transitório: espere o \`retry-after\` (${DATABASE_RETRY_AFTER_SECONDS} s) e repita. Numa escrita, repita com o mesmo \`Idempotency-Key\`: um 503 não garante que nada foi gravado. O corpo traz \`requestId\`.`,
        ["SERVICE_UNAVAILABLE"],
        { "retry-after": RETRY_AFTER_HEADER },
      ),
    );
  }

  // The limiter is registered with `global: true`, so every route has a
  // bucket unless it opts out explicitly.
  if (config.rateLimit !== false) {
    mergeResponse(
      responses,
      "429",
      errorBody(
        `RATE_LIMITED: limite de requisições excedido. Espere o tempo de \`retry-after\` antes de repetir. ${describeRateLimit(config.rateLimit)}`,
        ["RATE_LIMITED"],
        RATE_LIMIT_HEADERS,
      ),
    );
  }

  appendDescription(schema, notes);

  canonicalizeErrorResponses(responses);

  return result as { schema: FastifySchema; url: string };
}

export { openapiTransform };
