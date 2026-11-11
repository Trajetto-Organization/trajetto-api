import { z } from "zod";
import { boundedRecord } from "@/shared/validation/bounded-record";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { pageField, pageSizeField } from "@/shared/pagination/page-size";

import { DeliveryStatus, RouteStatus } from "@prisma/client";

import {
  ALL_TOPICS,
  TOPIC_WILDCARDS,
  isKnownSubscription,
} from "@/shared/integration/webhook-catalogue";
import {
  API_SCOPES,
  BUSINESS_API_RATE_PER_MINUTE,
  PLATFORM_API_KEY_RATE_CEILING,
  RESERVED_API_SCOPES,
  TENANT_API_KEY_RATE_CEILING,
  reservedScopesPhrase,
} from "@/shared/integration/api-key-rules";
import {
  HEADER_NAME_MAX_LENGTH,
  HEADER_VALUE_MAX_LENGTH,
  WEBHOOK_URL_MAX_LENGTH,
  hasUnreachableLiteralHost,
  hasUserInfo,
  invalidHeaderEntries,
  reservedHeaderNames,
} from "@/shared/integration/webhook-destination";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";
import { fieldError } from "@/shared/validation/field-error";

/**
 * A name a person types and another person reads back in a list: the same
 * text rules as every other name in the product (no space at the edges, no
 * run of spaces), so "ERP  Protheus" and "ERP Protheus " cannot sit beside
 * "ERP Protheus" as three different keys.
 */
function integrationName(subject: "da chave" | "do endpoint") {
  return z
    .string(
      fieldError({
        required: `O nome ${subject} é obrigatório.`,
        invalid: `O nome ${subject} deve ser um texto.`,
      }),
    )
    .min(2, `O nome ${subject} deve ter no mínimo 2 caracteres.`)
    .max(80, `O nome ${subject} deve ter no máximo 80 caracteres.`)
    .refine(
      (value) => !hasSpaceAtEdges(value),
      `O nome ${subject} não pode começar ou terminar com espaço.`,
    )
    .refine(
      (value) => !hasConsecutiveSpaces(value),
      `O nome ${subject} não pode ter espaços consecutivos.`,
    );
}

/**
 * Cursor paging, not offset, on every public list.
 *
 * An ERP pulling a customer's whole operation walks hundreds of pages, and
 * `OFFSET 40000` makes Postgres count forty thousand rows to throw them away.
 * A cursor also survives rows being inserted mid-walk, which offset does not —
 * an integration that skipped a delivery because one arrived between page 12
 * and page 13 would be an integration that loses documents silently.
 */
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

const integrationListSchema = z.object({
  // Published as the integer it is (plan of 02/11/2026, L2): the spec said
  // `string`, and every client generated from it typed the page size as text.
  // The clamp stays tolerant — garbage is never a 400, it is the default —
  // so the preprocess always hands the inner schema a number it accepts.
  limit: z
    .preprocess((value) => {
      // Floored at 1 as well as capped at 200. A negative number went
      // through the cap untouched, and Prisma reads a negative `take` as
      // "the last N rows": `limit=-1000000` loaded a tenant's whole history
      // into memory before the page code choked on it with a 500.
      const parsed = Math.trunc(Number(value));

      return value !== undefined && Number.isFinite(parsed) && parsed >= 1
        ? Math.min(parsed, LIST_LIMIT_MAX)
        : LIST_LIMIT_DEFAULT;
      // The default on the inner schema, where zod 4 publishes it (one on the
      // preprocess itself is left out of the document); the preprocess already
      // turns an absent limit into it.
    }, z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT))
    .describe(
      "Itens por página, de 1 a 200. O padrão é 50. Um valor fora da faixa é ajustado (acima de 200 vira 200; zero, negativo ou não numérico vira 50), nunca recusado.",
    ),

  cursor: z.string().optional().describe("O `next_cursor` da página anterior."),

  /** ISO date; everything changed at or after it. */
  updated_since: z
    .string()
    .datetime({ message: "updated_since deve ser uma data ISO 8601." })
    .optional()
    .describe(
      "Data ISO 8601: só o que mudou a partir desse instante. Em /events, o que chegou ao Trajetto a partir dele (a hora de chegada, não o occurred_at: um fato registrado offline chega depois).",
    ),
});

/**
 * A status filter checked against the enum it filters on, one per resource.
 *
 * It was a free string cast into the Prisma enum: an unknown value, or a real
 * one in lower case, made Prisma throw and the API answer 500 — counted on the
 * customer's usage panel as our failure. Case is forgiven because it carries
 * no meaning here; a value that does not exist is a 400 listing the ones that
 * do.
 */
function statusFilter<T extends Record<string, string>>(values: T) {
  const accepted = Object.values(values).join(", ");

  return z
    .preprocess(
      (value) => {
        if (typeof value !== "string") return value;

        // `status=` is "no filter", as the free string always read it: a
        // query built from a template sends it when nothing was picked.
        const normalized = value.trim().toUpperCase();

        return normalized === "" ? undefined : normalized;
      },
      z
        .nativeEnum(values, { error: `status deve ser um de: ${accepted}.` })
        .optional(),
    )
    .optional()
    .describe("Filtra pelo status atual. Maiúsculas ou minúsculas.");
}

const integrationDeliveryListSchema = integrationListSchema.extend({
  status: statusFilter(DeliveryStatus),
});

const integrationRouteListSchema = integrationListSchema.extend({
  status: statusFilter(RouteStatus),
});

// No `status`: the event feed never applied one, and publishing a filter that
// does not filter has an ERP syncing the wrong thing. A caller still sending
// it is not refused — the key is dropped, as it always was in effect.
const integrationEventListSchema = integrationListSchema;

const integrationIdParamSchema = z.object({
  id: z.string().uuid("Identificador inválido."),
});

/**
 * The token of an integrator's proof link (L7). Only bounded here: its shape
 * is checked by the use case, which answers every bad token with the same
 * 404 — a 400 for a malformed one would tell a prober what a real one looks
 * like.
 */
const proofLinkParamsSchema = z.object({
  token: z
    .string()
    .max(128, "Comprovante não encontrado.")
    .describe("O token do `proof_url`, como veio no payload."),
});

/** The refusal below agrees in number with however many are still reserved. */
const ONE_RESERVED = RESERVED_API_SCOPES.length === 1;

const createApiKeySchema = z.object({
  name: integrationName("da chave").describe(
    'Quem revoga precisa reconhecer qual é: "ERP Protheus". De 2 a 80 caracteres, sem espaço nas pontas nem espaços seguidos.',
  ),

  scopes: z
    .array(
      z.enum(API_SCOPES, {
        error: `Escopo desconhecido. Os escopos são: ${API_SCOPES.join(", ")}.`,
      }),
      fieldError({ required: "Escolha ao menos um escopo." }),
    )
    .min(1, "Escolha ao menos um escopo.")
    // Each scope once at most: the cap comes before the refinement, so a
    // longer list is refused before any element is read.
    .max(
      API_SCOPES.length,
      `Escolha no máximo ${API_SCOPES.length} escopos, cada um uma vez.`,
    )
    // A reserved scope guards no route yet. Issued today it would grant
    // access, silently, on the day a route starts requiring it — to a key
    // whose owner, when it was issued, was granting nothing.
    .refine(
      (scopes) => !scopes.some((scope) => RESERVED_API_SCOPES.includes(scope)),
      {
        message: `${reservedScopesPhrase()}: nenhum endpoint da v1 ${ONE_RESERVED ? "o" : "os"} exige ainda.`,
      },
    )
    .describe(
      `Leitura e escrita são separadas de propósito: deliveries:write cria entregas e não dá leitura, e deliveries:cancel cancela sem criar nem ler. ${reservedScopesPhrase()} e não ${ONE_RESERVED ? "pode ser emitido" : "podem ser emitidos"} até existir um endpoint que ${ONE_RESERVED ? "o" : "os"} exija.`,
    ),

  // Messages in Portuguese: a decimal used to come back as zod's English
  // "Expected integer, received float" under a Portuguese form (DLVB-20).
  rate_limit_per_minute: z
    .number(
      fieldError({
        invalid:
          "O limite por minuto deve ser um número inteiro de requisições.",
      }),
    )
    .int("O limite por minuto deve ser um número inteiro, sem casas decimais.")
    .min(10, "O limite mínimo é de 10 requisições por minuto.")
    .max(
      PLATFORM_API_KEY_RATE_CEILING,
      `O limite por chave vai até ${PLATFORM_API_KEY_RATE_CEILING.toLocaleString("pt-BR")} requisições por minuto.`,
    )
    .optional()
    .default(120)
    .describe(
      `Requisições por minuto desta chave, somadas entre as rotas. O administrador da empresa define até ${TENANT_API_KEY_RATE_CEILING}; acima disso (até ${PLATFORM_API_KEY_RATE_CEILING}), só o suporte da plataforma. Todas as chaves da empresa dividem ainda um teto de ${BUSINESS_API_RATE_PER_MINUTE} por minuto.`,
    ),
});

/** The whole catalogue, every topic and every wildcard. */
const MAX_WEBHOOK_SUBSCRIPTIONS = ALL_TOPICS.length + TOPIC_WILDCARDS.length;

const saveWebhookEndpointSchema = z.object({
  ...tenantLockedShape,
  name: integrationName("do endpoint"),

  url: z
    .string(fieldError({ required: "A URL é obrigatória." }))
    // Bounded: the URL is stored, listed and shown on every row of the
    // monitor, and no receiver needs a path longer than a browser accepts.
    .max(
      WEBHOOK_URL_MAX_LENGTH,
      `A URL do endpoint deve ter no máximo ${WEBHOOK_URL_MAX_LENGTH.toLocaleString("pt-BR")} caracteres.`,
    )
    .url("A URL do endpoint é inválida.")
    .refine(
      (value) => value.startsWith("https://"),
      "O endpoint precisa ser https: um webhook assinado em texto claro entrega o payload a quem estiver no caminho.",
    )
    // No request can be built from `https://user:password@host`: every
    // attempt threw until the endpoint was switched off.
    .refine(
      (value) => !hasUserInfo(value),
      "A URL não pode conter usuário e senha. Use um cabeçalho de autenticação.",
    )
    // A literal private address or a name like `localhost` can never be
    // delivered to; refused here instead of failing every send until the
    // breaker trips. Names that RESOLVE to private addresses are still caught
    // at send time, on every send (DNS can change).
    .refine(
      (value) => !hasUnreachableLiteralHost(value),
      "O endpoint precisa ser um endereço alcançável pela internet: endereços internos, de loopback e nomes como localhost não recebem eventos.",
    ),

  topics: z
    .array(z.string(), fieldError({ required: "Escolha ao menos um tópico." }))
    .min(1, "Escolha ao menos um tópico.")
    // Every topic and wildcard of the catalogue, once each: the cap comes
    // before the refinement, so a longer list is refused before any element
    // is read.
    .max(
      MAX_WEBHOOK_SUBSCRIPTIONS,
      `Escolha no máximo ${MAX_WEBHOOK_SUBSCRIPTIONS} tópicos, cada um uma vez.`,
    )
    // A wildcard is a topic PREFIX (`delivery.*`), matched as the dispatcher
    // matches it; a family name (`document.*`) or an invented prefix matched
    // nothing and left the endpoint mute without a word (decision 5.9).
    .superRefine((values, ctx) => {
      const unknown = [
        ...new Set(values.filter((value) => !isKnownSubscription(value))),
      ];

      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tópicos que não existem no catálogo: ${unknown.join(", ")}. Use os nomes do catálogo ou um dos curingas ${TOPIC_WILDCARDS.join(", ")}.`,
        });
      }
    })
    // Stored once each: the same subscription twice says nothing more.
    .transform((values) => [...new Set(values)])
    .describe(
      `Nomes do catálogo ou curingas de um nível (${TOPIC_WILDCARDS.join(", ")}). "Todos os eventos" de Documentos são os três curingas delivery.*, occurrence.* e proof.*.`,
    ),

  // The count first: each refused entry would be an issue of its own.
  headers: boundedRecord(
    20,
    "No máximo 20 cabeçalhos.",
    z.record(z.string(), z.string()),
  )
    // Omitted on an edit keeps what is stored (the web form has no headers
    // field); `null` clears them.
    .nullable()
    .optional()
    .refine(
      (value) => !value || reservedHeaderNames(value).length === 0,
      "Há cabeçalhos reservados neste endpoint. `X-Trajetto-Signature`, `Host` e afins são escritos por nós.",
    )
    // Checked here rather than discovered at send time: a value with a line
    // break made every POST throw, counted as a transient failure until the
    // breaker switched the endpoint off.
    .refine(
      (value) => !value || invalidHeaderEntries(value).length === 0,
      `Nome ou valor de cabeçalho inválido: nomes só com letras, números e - _ . (até ${HEADER_NAME_MAX_LENGTH}); valores sem quebra de linha e com até ${HEADER_VALUE_MAX_LENGTH} caracteres.`,
    )
    .describe(
      "Autenticação que o gateway do receptor exige. Os cabeçalhos que NÓS escrevemos são reservados: a assinatura é a garantia que a documentação promete, e um cliente que a substituísse transformaria um receptor compartilhado em alvo de replay. Numa edição, omitir mantém os atuais e `null` apaga.",
    ),

  is_active: z.boolean().optional().default(true),
});

/**
 * The monitor's periods. Rolling windows and not calendar days: the question
 * is "o que aconteceu nas últimas 24 horas", asked at any hour.
 */
const MONITOR_WINDOWS = ["24h", "7d", "30d"] as const;

type MonitorWindow = (typeof MONITOR_WINDOWS)[number];

const MONITOR_WINDOW_MS: Record<MonitorWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * How far the monitor's list counts and pages (DLVB-30).
 *
 * Counting a large tenant's month exactly scanned every row on each open and
 * "Atualizar" (349 ms at 600k rows, growing with volume) for a pager nobody
 * walks past page 50. Past this many rows the total says "mais de" and the
 * person filters instead; the cards stay exact.
 */
const MONITOR_LIST_CAP = 10_000;

const listWebhookDeliveriesSchema = z.object({
  page: pageField(),
  pageSize: pageSizeField(20),

  status: z
    .enum(["PENDING", "PROCESSING", "DELIVERED", "FAILED", "QUEUED"], {
      error:
        "status deve ser um de: PENDING, PROCESSING, DELIVERED, FAILED, QUEUED.",
    })
    .optional()
    .describe(
      "Só as entregas neste estado. QUEUED é a fila inteira — PENDING e PROCESSING juntos, inclusive um envio interrompido que espera ser retomado — e é o que o contador `pending` conta.",
    ),

  window: z
    .enum(MONITOR_WINDOWS, {
      error: `window deve ser um de: ${MONITOR_WINDOWS.join(", ")}.`,
    })
    .optional()
    .default("24h")
    .describe(
      "O período dos eventos concluídos (entregues e com falha), pela criação do evento: 24h (padrão), 7d ou 30d. Lista e contadores usam o MESMO período. A fila (PENDING e PROCESSING) entra sempre, qualquer que seja a idade.",
    ),

  endpointId: z
    .string()
    .uuid("ID do endpoint é inválido.")
    .optional()
    .describe("Só as entregas para este endpoint."),
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

/**
 * The window the usage screen asks about.
 *
 * Days and not a free date range, because the table is aggregated by day and a
 * range that could start mid-day would be a filter the data cannot honour —
 * the worst kind, since it answers rather than refusing.
 */
const listApiUsageSchema = z.object({
  days: z
    .string()
    .optional()
    .transform((value) => Math.min(Math.max(Number(value) || 7, 1), 90))
    .describe("De 1 a 90 dias. O padrão é 7."),

  apiKeyId: z
    .string()
    .uuid("ID da chave é inválido.")
    .optional()
    .describe("Só o uso desta chave; ausente, todas as da empresa."),
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

export {
  MONITOR_LIST_CAP,
  MONITOR_WINDOWS,
  MONITOR_WINDOW_MS,
  createApiKeySchema,
  listApiUsageSchema,
  integrationIdParamSchema,
  integrationListSchema,
  integrationDeliveryListSchema,
  integrationRouteListSchema,
  integrationEventListSchema,
  listWebhookDeliveriesSchema,
  proofLinkParamsSchema,
  saveWebhookEndpointSchema,
};
export type { MonitorWindow };
