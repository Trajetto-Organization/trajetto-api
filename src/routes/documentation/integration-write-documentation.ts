import { z } from "zod";

import { createIntegrationDeliverySchema } from "@/schemas/create-integration-delivery-schema";
import { cancelIntegrationDeliverySchema } from "@/schemas/cancel-integration-delivery-schema";
import { batchBodyDocumentation } from "@/schemas/create-integration-deliveries-batch-schema";
import { INTEGRATION_IDEMPOTENCY_KEY_PATTERN } from "@/modules/integration/usecases/create-delivery/integration-idempotency-key";
import { NOT_CANCELLABLE_STATUSES } from "@/shared/integration/cancel-delivery-rules";
import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";

import { SERVICE_BUSY_DESCRIPTION } from "./database-busy-documentation";
import { integrationResponses } from "./integration-documentation";
import {
  publicBusinessRateLimitResponse,
  publicInternalErrorResponse,
  publicNotFoundResponse,
  publicServiceUnavailableResponse,
} from "./public-docs-responses";
import {
  CANCEL_DELIVERY_REQUEST_BODY,
  CREATE_DELIVERIES_BATCH_REQUEST_BODY,
  CREATE_DELIVERY_REQUEST_BODY,
} from "./public-docs-examples";

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
    "Em VALIDATION_ERROR é a frase em português do primeiro campo recusado; a lista completa, uma frase por problema, está em `issues`. Em MALFORMED_REQUEST é a frase do servidor HTTP, em inglês (por exemplo, `Body is not valid JSON but content-type is set to 'application/json'`). Nos demais códigos, uma frase em português.",
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
      message: z
        .string()
        .describe("Texto fixo, sem tradução (`Internal server error`)."),
      requestId: z
        .string()
        .optional()
        .describe(
          "Informe ao suporte: é por ele que o erro é encontrado no registro.",
        ),
    })
    .describe(
      "INTERNAL_ERROR: falha nossa. Repita com a MESMA Idempotency-Key: se a entrega chegou a ser criada, a repetição a devolve em vez de duplicar.",
    ),

  // Shared with the reads: the company ceiling's 429 (merged by the
  // transform with the per-key one) and the database outage's 503.
  tooManyRequests: publicBusinessRateLimitResponse,
  unavailable: publicServiceUnavailableResponse,
};

/**
 * The batch (plano-escala U-04): one answer for the call, one result per
 * delivery, at its position.
 */
const batchDeliveryResult = z
  .object({
    index: z
      .number()
      .int()
      .describe("A posição da entrega em `deliveries`, a partir de 0."),
    idempotency_key: z
      .string()
      .nullable()
      .describe(
        "A `idempotency_key` que a entrega trouxe; null quando faltou ou não segue o formato.",
      ),
    status: z
      .number()
      .int()
      .describe(
        "201: criada agora. 200: esta `idempotency_key` já tinha criado esta entrega com o mesmo corpo (nada criado nem avisado de novo). 4xx: recusada, com `code` e `message` iguais aos da criação avulsa (400 VALIDATION_ERROR, IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_INVALID ou SHIPPER_INACTIVE; 404 SHIPPER_NOT_FOUND; 409 IDEMPOTENCY_KEY_REUSED ou DELIVERY_INVOICE_KEY_EXISTS).",
      ),
    delivery_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        "A entrega criada (201), a já criada por esta chave (200) ou, num 409, a que está no caminho. Sempre da sua empresa.",
      ),
    code: z
      .string()
      .optional()
      .describe("Só numa recusa: o código estável para decidir."),
    message: z
      .string()
      .optional()
      .describe("Só numa recusa: a frase em português, a da criação avulsa."),
    issues: z
      .array(z.string())
      .optional()
      .describe(
        "Só em VALIDATION_ERROR: uma frase por problema, com o campo na frente.",
      ),
  })
  .describe("O que aconteceu com uma entrega do lote.");

const integrationBatchResponses = {
  processed: z
    .object({
      results: z
        .array(batchDeliveryResult)
        .describe("Um resultado por entrega, na ordem em que vieram."),
      created: z.number().int().describe("Quantas foram criadas agora (201)."),
      replayed: z
        .number()
        .int()
        .describe("Quantas já existiam por esta chave (200)."),
      refused: z.number().int().describe("Quantas foram recusadas (4xx)."),
    })
    .describe(
      "O lote foi processado, entrega por entrega, cada uma na sua transação: o sucesso pode ser parcial. Reenvie só as recusadas, corrigidas, ou o lote inteiro com as mesmas `idempotency_key`: as já criadas voltam como 200, com o mesmo `delivery_id`, sem duplicar.",
    ),

  badRequest: codedError(
    'VALIDATION_ERROR: o corpo não é `{ "deliveries": [...] }`, a lista está vazia, tem mais de 100 entregas ou o corpo tem outro campo; nenhuma entrega foi lida nem gravada. MALFORMED_REQUEST: o corpo não é JSON válido. Uma entrega com problema não recusa o lote: ela vem com o seu status em `results`.',
    "Em VALIDATION_ERROR é a frase em português do primeiro problema; a lista completa está em `issues`. Em MALFORMED_REQUEST é a frase do servidor HTTP, em inglês.",
  ),

  internalError: z
    .object({
      code: z.string().describe("INTERNAL_ERROR."),
      status: z.string().optional(),
      message: z
        .string()
        .describe("Texto fixo, sem tradução (`Internal server error`)."),
      requestId: z
        .string()
        .optional()
        .describe(
          "Informe ao suporte: é por ele que o erro é encontrado no registro.",
        ),
    })
    .describe(
      "INTERNAL_ERROR: falha nossa no meio do lote, que parou ali. Reenvie o lote inteiro com as MESMAS `idempotency_key`: as entregas que chegaram a ser criadas voltam como 200, sem duplicar.",
    ),

  tooLarge: codedError(
    "BATCH_TOO_LARGE: o corpo passa do limite de tamanho do lote, dito na descrição da rota. Nenhuma entrega foi lida nem gravada, e só a chamada contou nos limites por minuto, como uma avulsa: divida as entregas em lotes menores e envie cada um.",
  ),

  // Shared with the reads: the company ceiling's 429 (merged by the
  // transform with the per-key one). Each delivery counts one call.
  tooManyRequests: publicBusinessRateLimitResponse,
  unavailable: publicServiceUnavailableResponse,
};

/**
 * The public cancel (L9, D49). No Idempotency-Key: the delivery's own state
 * makes a repeat harmless, so the 500 and the 503 say "repeat" without one.
 */
const integrationCancelResponses = {
  cancelled: integrationResponses.deliveryCancellation.describe(
    "A entrega está cancelada. Cancelada agora por esta chamada, o cabeçalho `idempotent-replayed` vem `false`: o histórico ganhou a mudança com o seu motivo, a parada saiu da rota que ainda não tinha saído e os assinantes de `delivery.cancelled` recebem o webhook. Já estava cancelada (uma repetição, outra chave ou o painel), vem `true`: nada foi gravado nem anunciado de novo. Só os identificadores e o status voltam: este escopo não dá leitura da entrega.",
  ),

  badRequest: codedError(
    "VALIDATION_ERROR: faltou o `reason`, ele não segue as regras (de 3 a 500 caracteres, sem espaço nas pontas nem espaços seguidos), o corpo tem um campo que não existe, ou o `id` não é um UUID. Cada item de `issues` sobre o corpo começa pelo campo (`reason: …`, `corpo: campo não reconhecido: …`); um `id` que não é UUID vem como `Identificador inválido.`. MALFORMED_REQUEST: o corpo não é JSON válido. Nada foi gravado: corrija antes de repetir.",
    "Em VALIDATION_ERROR é a frase em português do primeiro campo recusado; a lista completa, uma frase por problema, está em `issues`. Em MALFORMED_REQUEST é a frase do servidor HTTP, em inglês (por exemplo, `Body is not valid JSON but content-type is set to 'application/json'`).",
  ),

  notFound: publicNotFoundResponse.describe(
    "NOT_FOUND: nenhuma entrega com este `id` na sua empresa. Uma entrega de outra empresa recebe exatamente a mesma resposta, e nada é gravado nela.",
  ),

  conflict: z
    .object({
      code: z
        .string()
        .describe("DELIVERY_NOT_CANCELLABLE ou DELIVERY_STATUS_CONFLICT."),
      message: z.string().describe("Frase em português."),
      // From the verdict table, so the closed schema never lists a status
      // the API stopped refusing, or misses one it started to.
      delivery_status: z
        .enum(NOT_CANCELLABLE_STATUSES)
        .optional()
        .describe(
          "Só em DELIVERY_NOT_CANCELLABLE: o status que impede o cancelamento.",
        ),
    })
    .describe(
      "DELIVERY_NOT_CANCELLABLE: a entrega já foi concluída (`delivery_status` DELIVERED) ou já saiu com o motorista (IN_TRANSIT). Uma carga em rota é cancelada pela transportadora, no painel; repetir não muda a resposta. DELIVERY_STATUS_CONFLICT: o status da entrega mudou durante o pedido e nada foi gravado; repita, e a resposta considera o status novo.",
    ),

  internalError: publicInternalErrorResponse.describe(
    "INTERNAL_ERROR: falha nossa. Repetir é seguro: se o cancelamento chegou a ser gravado, a repetição responde 200 com `idempotent-replayed: true`, sem cancelar nem anunciar de novo.",
  ),

  // Shared with the reads: the company ceiling's 429 (merged by the
  // transform with the per-key one).
  tooManyRequests: publicBusinessRateLimitResponse,

  // The route's own words stand alone: the transform does not add the keyed
  // routes' generic 503, which speaks of the Idempotency-Key (mergeResponse).
  unavailable: publicServiceUnavailableResponse.describe(
    `SERVICE_UNAVAILABLE: o banco de dados está indisponível por instantes. Transitório: espere o \`retry-after\` (${DATABASE_RETRY_AFTER_SECONDS} s) e repita. ${SERVICE_BUSY_DESCRIPTION} Um 503 não garante que nada foi gravado, e repetir é seguro do mesmo jeito: uma entrega já cancelada responde 200 com \`idempotent-replayed: true\`. O corpo traz \`requestId\`.`,
  ),
};

const integrationWriteSchemas = {
  createDelivery: createIntegrationDeliverySchema,
  createDeliveriesBatch: batchBodyDocumentation,
  idempotencyHeaders: integrationIdempotencyHeaders,
  cancelDelivery: cancelIntegrationDeliverySchema,
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
    JSON.stringify(CREATE_DELIVERY_REQUEST_BODY, null, 2)
      .split("\n")
      .join("\n  ") +
    "'",
  "```",
].join("\n");

/** The batch's call, with the published example body (same rule as above). */
const CREATE_DELIVERIES_BATCH_REQUEST_EXAMPLE = [
  "```bash",
  "curl -X POST https://<api>/integration/v1/deliveries/batch \\",
  '  -H "Authorization: Bearer tjk_live_<prefixo>.<segredo>" \\',
  '  -H "Content-Type: application/json" \\',
  "  -d '" +
    JSON.stringify(CREATE_DELIVERIES_BATCH_REQUEST_BODY, null, 2)
      .split("\n")
      .join("\n  ") +
    "'",
  "```",
].join("\n");

/** The cancel's call, with the published example body (same rule as above). */
const CANCEL_DELIVERY_REQUEST_EXAMPLE = [
  "```bash",
  "curl -X POST https://<api>/integration/v1/deliveries/<id>/cancel \\",
  '  -H "Authorization: Bearer tjk_live_<prefixo>.<segredo>" \\',
  '  -H "Content-Type: application/json" \\',
  "  -d '" + JSON.stringify(CANCEL_DELIVERY_REQUEST_BODY) + "'",
  "```",
].join("\n");

export {
  CANCEL_DELIVERY_REQUEST_EXAMPLE,
  CREATE_DELIVERIES_BATCH_REQUEST_EXAMPLE,
  CREATE_DELIVERY_REQUEST_EXAMPLE,
  integrationBatchResponses,
  integrationCancelResponses,
  integrationIdempotencyHeaders,
  integrationWriteResponses,
  integrationWriteSchemas,
};
