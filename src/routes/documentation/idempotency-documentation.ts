import { z } from "zod";

/**
 * The header that makes a driver's retry safe, as the document states it.
 *
 * Declared through `config.openapi.headers`, never as `schema.headers`: a
 * headers schema would be VALIDATED by Fastify, which then replaces
 * `request.headers` with the parsed object — and a zod object drops every
 * header it does not name (content type, accept-encoding, user agent) for
 * everything that runs after validation. Documentation only.
 */
const idempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .uuid()
    .optional()
    .describe(
      "UUID do envio, gerado UMA vez pelo app e repetido em cada retentativa. Vira `client_submission_id` quando o corpo não traz um. Repetir a mesma chave devolve o registro já criado em vez de duplicar; uma chave já usada por outro motorista responde 409 SUBMISSION_OWNER_MISMATCH.",
    ),
});

/**
 * The same header on the panel's creates (IDEMP-14): the web keeps one key
 * per form and repeats it when the user saves again after a lost answer.
 * Documentation only, for the reason above.
 */
const panelIdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .uuid()
    .optional()
    .describe(
      "UUID do formulário, gerado uma vez e repetido quando o mesmo envio é salvo de novo (resposta perdida, segundo clique). Repetir a mesma chave responde com o registro já criado, sem duplicar nem notificar de novo. Opcional: sem ela, cada envio cria um registro. Única por empresa. Num aviso em massa do chat, cada motorista recebe a mensagem uma vez por chave.",
    ),
});

/**
 * The same header where the route refuses a request without it (POST
 * /chat/tickets answers 400 IDEMPOTENCY_KEY_REQUIRED): documented as
 * required, not as the panel's optional one.
 */
const requiredPanelIdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .uuid()
    .describe(
      "Obrigatório (sem ele, 400 IDEMPOTENCY_KEY_REQUIRED). UUID do formulário, gerado uma vez e repetido quando o mesmo envio é salvo de novo: a mesma chave devolve o mesmo registro, sem duplicar nem notificar de novo. Único por empresa.",
    ),
});

export {
  idempotencyHeaders,
  panelIdempotencyHeaders,
  requiredPanelIdempotencyHeaders,
};
