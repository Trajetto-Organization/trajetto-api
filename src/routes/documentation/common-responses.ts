import { z } from "zod";

/**
 * The one shape every error leaves the API in (decision 11.3).
 *
 * Documentation, never a filter: the error handler in http.ts sends its
 * bodies already serialized, and a 4xx body a controller sends itself is
 * serialized as built (shared/errors/error-body.ts), gaining a code from its
 * status when it has none. The OpenAPI transform rebuilds every published
 * error schema from this shape, so a route's own error schema only adds its
 * description and any detail fields.
 */
const errorResponse = z.object({
  code: z
    .string()
    .describe(
      "Código estável para o cliente decidir (ex.: VALIDATION_ERROR, RATE_LIMITED). Também vem no cabeçalho x-error-code.",
    ),
  message: z.string().describe("Frase para mostrar a quem está usando."),
  issues: z
    .array(z.string())
    .optional()
    .describe("Só em 400 VALIDATION_ERROR: uma frase por campo recusado."),
});

/** The handler's 500: a fixed sentence and the id to find it in the logs. */
const internalErrorResponse = z
  .object({
    code: z.enum(["INTERNAL_ERROR"]),
    status: z.enum(["error"]),
    message: z.string().describe("Texto fixo, sem detalhes da falha."),
    requestId: z
      .string()
      .describe(
        "O mesmo valor do cabeçalho `x-request-id`: informe-o ao suporte para localizar a falha.",
      ),
  })
  .describe(
    "INTERNAL_ERROR: falha nossa. Repetir com espera pode funcionar; se persistir, envie o `requestId` ao suporte.",
  );

export { errorResponse, internalErrorResponse };
