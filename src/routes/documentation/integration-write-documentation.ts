import { z } from "zod";

import { createIntegrationDeliverySchema } from "@/schemas/create-integration-delivery-schema";
import { INTEGRATION_IDEMPOTENCY_KEY_PATTERN } from "@/modules/integration/usecases/create-delivery/integration-idempotency-key";

import { integrationResponses } from "./integration-documentation";
import {
  publicBusinessRateLimitResponse,
  publicServiceUnavailableResponse,
} from "./public-docs-responses";
import { CREATE_DELIVERY_REQUEST_BODY } from "./public-docs-examples";

/**
 * The public create (decision 5.10), as the reference publishes it.
 *
 * Every error schema here is the body the API really sends — `{ code,
 * message }` from the error handler, `issues` on a validation error, and the
 * 409s' `delivery_id` — so a client generated from the document keeps the
 * field it decides on (DOCS-02).
 */

/**
 * Required, unlike the panel's. Documentation only (config.openapi): a
 * `schema.headers` would be validated by Fastify, which replaces
 * `request.headers` with the parsed object and drops every header it does
 * not name (see idempotency-documentation).
 */
const integrationIdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .regex(INTEGRATION_IDEMPOTENCY_KEY_PATTERN)
    .describe(
      "OBRIGATÓRIA. Um valor por documento, de 8 a 128 caracteres entre letras, números e . _ : - (um UUID serve; um valor derivado do seu documento, como `pedido-10452`, também). Repita o MESMO valor em toda nova tentativa do mesmo envio: com o mesmo corpo, a resposta é a entrega já criada (200), sem duplicar nem avisar de novo. O mesmo valor com outro corpo é recusado com 409 IDEMPOTENCY_KEY_REUSED. A chave é única por empresa, entre todas as suas chaves de API e os cadastros feitos no painel: um valor que o painel já usou também recebe 409, nunca a entrega do painel.",
    ),
});

/**
 * The handler's `{ code, message }`, with `issues` on a validation error.
 * `message` is described per response because it is not always Portuguese:
 * Fastify's JSON parser sends its own English reason, and the document must
 * say what really comes (decision 11.3).
 */
const codedError = (
  description: string,
  message = "Frase em português, pronta para mostrar a quem usa.",
) =>
  z
    .object({
      // Required: every refusal goes through AppError and the error handler,
      // which always send it, so a strict client keeps the decision field.
      code: z.string().describe("Código estável para decidir."),
      message: z.string().describe(message),
      issues: z
        .array(z.string())
        .optional()
        .describe(
          "Só em VALIDATION_ERROR: uma frase por problema, com o campo na frente (`cep: O CEP deve ter exatamente 8 dígitos.`, `items.0.description: campo obrigatório.`).",
        ),
    })
    .describe(description);

const integrationWriteResponses = {
  created: integrationResponses.delivery.describe(
    "Entrega criada agora, no formato de GET /integration/v1/deliveries/{id}. Guarde o `id`: é por ele (e pelo seu `code` e pela chave da NF-e) que os eventos e webhooks se referem a ela. O cabeçalho `idempotent-replayed` vem `false`.",
  ),

  replayed: integrationResponses.delivery.describe(
    "Repetição: esta Idempotency-Key já criou esta entrega com este mesmo corpo. Nada foi criado nem anunciado de novo; a entrega vem como está agora (o status pode já ter mudado). O cabeçalho `idempotent-replayed` vem `true`.",
  ),

  badRequest: codedError(
    "VALIDATION_ERROR: o corpo não passou nas regras do cadastro manual de entregas (as mesmas frases), ou tem um campo que não existe, no corpo ou num item; cada item de `issues` começa pelo campo. IDEMPOTENCY_KEY_REQUIRED: faltou o cabeçalho Idempotency-Key. IDEMPOTENCY_KEY_INVALID: o valor não segue o formato. SHIPPER_INACTIVE: o embarcador está desativado no painel. MALFORMED_REQUEST: o corpo não é JSON válido. Nada foi gravado: corrija antes de repetir.",
    "Em VALIDATION_ERROR é a frase em português do primeiro campo recusado; a lista completa, uma frase por problema, está em `issues`. Em MALFORMED_REQUEST é o motivo dado pelo leitor de JSON, em inglês (por exemplo, a posição em que o JSON quebrou). Nos demais códigos, uma frase em português.",
  ),

  notFound: codedError(
    "SHIPPER_NOT_FOUND: nenhum embarcador da sua empresa com este `shipper_id` ou `shipper_cnpj`. Um embarcador de outra empresa recebe exatamente a mesma resposta.",
  ),

  conflict: z
    .object({
      code: z
        .string()
        .describe("IDEMPOTENCY_KEY_REUSED ou DELIVERY_INVOICE_KEY_EXISTS."),
      message: z.string().describe("Frase em português."),
      delivery_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "A entrega que está no caminho: a que esta Idempotency-Key criou, ou a que já tem esta chave de NF-e. Sempre da sua empresa.",
        ),
    })
    .describe(
      "IDEMPOTENCY_KEY_REUSED: esta Idempotency-Key já criou uma entrega com OUTROS dados, ou já foi usada por um cadastro feito no painel — gere uma chave nova para um documento novo. A comparação é com a entrega como está gravada: se ela foi editada no painel depois de criada, ou se o CNPJ do embarcador mudou no cadastro e o envio o identifica por `shipper_cnpj`, repetir o corpo original também cai aqui; consulte-a pelo `delivery_id` (identificar o embarcador por `shipper_id` evita o segundo caso). DELIVERY_INVOICE_KEY_EXISTS: já existe uma entrega com esta chave de NF-e na sua empresa (inclusive numa corrida entre dois envios); a mesma nota não gera duas entregas.",
    ),

  internalError: z
    .object({
      code: z.string().describe("INTERNAL_ERROR."),
      status: z.string().optional(),
      message: z.string().describe("Texto fixo, sem tradução (`Internal server error`)."),
      requestId: z
        .string()
        .optional()
        .describe("Informe ao suporte: é por ele que o erro é encontrado no registro."),
    })
    .describe(
      "INTERNAL_ERROR: falha nossa. Repita com a MESMA Idempotency-Key: se a entrega chegou a ser criada, a repetição a devolve em vez de duplicar.",
    ),

  // Shared with the reads: the company ceiling's 429 (merged by the
  // transform with the per-key one) and the database outage's 503.
  tooManyRequests: publicBusinessRateLimitResponse,
  unavailable: publicServiceUnavailableResponse,
};

const integrationWriteSchemas = {
  createDelivery: createIntegrationDeliverySchema,
  idempotencyHeaders: integrationIdempotencyHeaders,
};

/**
 * What the reference shows under the route: the call, with the body the
 * document publishes as the request example (public-docs-examples), so the
 * curl and the example never drift apart. In the description because a
 * renderer may show only the prose.
 */
const CREATE_DELIVERY_REQUEST_EXAMPLE = [
  "```bash",
  "curl -X POST https://<api>/integration/v1/deliveries \\",
  '  -H "Authorization: Bearer tjk_live_<prefixo>.<segredo>" \\',
  '  -H "Idempotency-Key: pedido-10452" \\',
  '  -H "Content-Type: application/json" \\',
  "  -d '" +
    JSON.stringify(CREATE_DELIVERY_REQUEST_BODY, null, 2).split("\n").join("\n  ") +
    "'",
  "```",
].join("\n");

export {
  CREATE_DELIVERY_REQUEST_EXAMPLE,
  integrationIdempotencyHeaders,
  integrationWriteResponses,
  integrationWriteSchemas,
};
