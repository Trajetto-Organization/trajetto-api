import { z } from "zod";

import { ALL_TOPICS } from "@/shared/integration/webhook-catalogue";
import { API_SCOPES } from "@/shared/integration/api-key-rules";
import { reservedHeaderNames } from "@/shared/integration/webhook-destination";

/**
 * Cursor paging, not offset, on every public list.
 *
 * An ERP pulling a customer's whole operation walks hundreds of pages, and
 * `OFFSET 40000` makes Postgres count forty thousand rows to throw them away.
 * A cursor also survives rows being inserted mid-walk, which offset does not —
 * an integration that skipped a delivery because one arrived between page 12
 * and page 13 would be an integration that loses documents silently.
 */
const integrationListSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => Math.min(Number(value) || 50, 200))
    .describe("Até 200 por página. O padrão é 50."),

  cursor: z
    .string()
    .optional()
    .describe("O `next_cursor` da página anterior."),

  /** ISO date; everything changed at or after it. */
  updated_since: z
    .string()
    .datetime({ message: "updated_since deve ser uma data ISO 8601." })
    .optional(),

  status: z.string().optional(),
});

const integrationIdParamSchema = z.object({
  id: z.string().uuid("Identificador inválido."),
});

const createApiKeySchema = z.object({
  name: z
    .string({ required_error: "Dê um nome à chave." })
    .min(2, "O nome da chave deve ter no mínimo 2 caracteres.")
    .max(80, "O nome da chave deve ter no máximo 80 caracteres.")
    .describe('Quem revoga precisa reconhecer qual é: "ERP Protheus".'),

  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, "Escolha ao menos um escopo.")
    .describe("Leitura e escrita são separadas de propósito."),

  rate_limit_per_minute: z
    .number()
    .int()
    .min(10)
    .max(6000)
    .optional()
    .default(120),
});

const saveWebhookEndpointSchema = z.object({
  name: z
    .string({ required_error: "Dê um nome ao endpoint." })
    .min(2, "O nome deve ter no mínimo 2 caracteres.")
    .max(80, "O nome deve ter no máximo 80 caracteres."),

  url: z
    .string({ required_error: "A URL é obrigatória." })
    .url("A URL do endpoint é inválida.")
    .refine(
      (value) => value.startsWith("https://"),
      "O endpoint precisa ser https: um webhook assinado em texto claro entrega o payload a quem estiver no caminho.",
    ),

  topics: z
    .array(z.string())
    .min(1, "Escolha ao menos um tópico.")
    .refine(
      (values) =>
        values.every(
          (value) =>
            (ALL_TOPICS as string[]).includes(value) ||
            /^[a-z]+\.\*$/.test(value),
        ),
      "Há tópicos que não existem no catálogo.",
    ),

  headers: z
    .record(z.string())
    .optional()
    .refine(
      (value) => !value || reservedHeaderNames(value).length === 0,
      "Há cabeçalhos reservados neste endpoint. `X-Trajetto-Signature`, `Host` e afins são escritos por nós.",
    )
    .refine(
      (value) => !value || Object.keys(value).length <= 20,
      "No máximo 20 cabeçalhos.",
    )
    .describe(
      "Autenticação que o gateway do receptor exige. Os cabeçalhos que NÓS escrevemos são reservados: a assinatura é a garantia que a documentação promete, e um cliente que a substituísse transformaria um receptor compartilhado em alvo de replay.",
    ),

  is_active: z.boolean().optional().default(true),
});

const listWebhookDeliveriesSchema = z.object({
  page: z
    .string()
    .transform((value) => Number(value) || 1)
    .refine((value) => value >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((value) => Number(value) || 20)
    .refine(
      (value) => value >= 1 && value <= 100,
      "A quantidade de itens por página deve estar entre 1 e 100.",
    ),

  status: z
    .enum(["PENDING", "PROCESSING", "DELIVERED", "FAILED"])
    .optional(),

  endpointId: z.string().uuid("ID do endpoint é inválido.").optional(),
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
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

  apiKeyId: z.string().uuid("ID da chave é inválido.").optional(),
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
});

export {
  createApiKeySchema,
  listApiUsageSchema,
  integrationIdParamSchema,
  integrationListSchema,
  listWebhookDeliveriesSchema,
  saveWebhookEndpointSchema,
};
