import { z } from "zod";

import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";

declare module "fastify" {
  interface FastifySchema {
    /**
     * Documentation only: the API-key scopes the route's `verifyApiScope`
     * requires. @fastify/swagger copies `x-*` keys onto the operation, and the
     * public reference shows them per endpoint.
     */
    "x-scopes"?: readonly string[];
  }
}

/**
 * The public API's refusals, in the shape the error handler (http.ts) sends.
 *
 * The routes declared `{ message }` for 404 and 500, closed with
 * `additionalProperties: false`, while the runtime sends `code` too, plus
 * `status` and `requestId` on a 500: a client generated from the reference
 * with strict validation rejected the real body, and the `code` it should
 * decide on only existed in prose. Documentation only: the handler sends a
 * serialized string, so these never filter a response.
 *
 * 401, 403 and the per-key 429 are not here: the OpenAPI transform derives
 * them from `ensureApiKey`, already with their codes.
 */
function publicErrorBody(codes: readonly string[]) {
  return z.object({
    code: z.string().describe(`Um destes: ${codes.join(", ")}.`),
    message: z
      .string()
      .describe("Frase em português, pronta para mostrar a quem usa."),
  });
}

const publicBadRequestResponse = publicErrorBody([
  "VALIDATION_ERROR",
  "MALFORMED_REQUEST",
])
  .extend({
    // VALIDATION_ERROR carries the first refused field's pt-BR sentence;
    // MALFORMED_REQUEST, Fastify's JSON parser reason (English).
    message: z
      .string()
      .describe(
        "Em VALIDATION_ERROR é a frase em português do primeiro campo recusado; a lista completa, uma frase por problema, está em `issues`. Em MALFORMED_REQUEST é o motivo dado pelo leitor de JSON, em inglês (por exemplo, a posição em que o JSON quebrou).",
      ),
    issues: z
      .array(z.string())
      .optional()
      .describe("Só em VALIDATION_ERROR: uma frase por campo ou parâmetro recusado."),
  })
  .describe(
    "Requisição recusada: VALIDATION_ERROR (um campo ou parâmetro inválido; uma frase por campo em `issues`) ou MALFORMED_REQUEST (corpo que não é JSON válido). Corrija antes de repetir.",
  );

const publicNotFoundResponse = publicErrorBody(["NOT_FOUND"]).describe(
  "NOT_FOUND: não existe, ou é de outra empresa. As duas respostas são iguais de propósito, para uma chave não confirmar os ids de outra empresa.",
);

/**
 * The company ceiling's 429. Merged by the transform with the per-key one it
 * derives from `ensureApiKey`, so the two causes read side by side.
 */
const publicBusinessRateLimitResponse = publicErrorBody(["RATE_LIMITED"]).describe(
  "RATE_LIMITED também quando a EMPRESA da chave atingiu o teto por minuto somado entre todas as chaves dela; essa recusa traz só `retry-after`, sem os cabeçalhos `x-ratelimit-*`.",
);

const publicInternalErrorResponse = z
  .object({
    code: z.enum(["INTERNAL_ERROR"]),
    status: z.enum(["error"]),
    message: z.string(),
    requestId: z
      .string()
      .describe(
        "O mesmo valor do cabeçalho `x-request-id`: informe-o ao suporte para localizar a falha.",
      ),
  })
  .describe(
    "INTERNAL_ERROR: falha nossa. Repetir com espera pode funcionar; se persistir, envie o `requestId` ao suporte.",
  );

const publicServiceUnavailableResponse = z
  .object({
    code: z.enum(["SERVICE_UNAVAILABLE"]),
    message: z.string(),
    requestId: z
      .string()
      .describe("O mesmo valor do cabeçalho `x-request-id`."),
  })
  .describe(
    `SERVICE_UNAVAILABLE: o banco de dados está indisponível por instantes. Transitório: espere o \`retry-after\` (${DATABASE_RETRY_AFTER_SECONDS} s) e repita. Numa escrita, repita com o mesmo \`Idempotency-Key\`: um 503 não garante que nada foi gravado.`,
  );

export {
  publicBadRequestResponse,
  publicBusinessRateLimitResponse,
  publicErrorBody,
  publicInternalErrorResponse,
  publicNotFoundResponse,
  publicServiceUnavailableResponse,
};
