import { z } from "zod";

/**
 * What `errorResponse` says about `code` when the route names no code. Not
 * a list: where a hook documents its codes on the same status, the OpenAPI
 * transform publishes the hook's list in its place.
 */
const GENERIC_CODE_DESCRIPTION =
  "Código estável para o cliente decidir (ex.: VALIDATION_ERROR, RATE_LIMITED). Também vem no cabeçalho x-error-code.";

/**
 * How a closed list of codes is written in a refusal's `code`. When a route's
 * own refusal and a hook's land on the same status, the OpenAPI transform
 * joins two of these into one list (openapi-transform.ts, mergeResponse).
 */
function codeList(codes: readonly string[]): string {
  return `Um destes: ${codes.join(", ")}.`;
}

/** The codes of a `codeList` sentence; null for any other description. */
function codesOf(description: string): string[] | null {
  const match = /^Um destes: (.+)\.$/.exec(description);

  return match ? match[1].split(", ") : null;
}

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
  code: z.string().describe(GENERIC_CODE_DESCRIPTION),
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

/**
 * A refusal whose codes are a closed list, in the form the transform merges
 * with the codes the route's hooks add on the same status.
 */
function codedRefusal(description: string, codes: readonly string[]) {
  return z
    .object({
      code: z.string().describe(codeList(codes)),
      message: z.string().describe("Frase para mostrar a quem está usando."),
    })
    .describe(description);
}

/**
 * The bcrypt gate's refusal (shared/security/bcrypt-gate.ts), declared by
 * every route whose use case hashes or compares a password or a one-time
 * code through it. The gate refuses before the work starts, so nothing was
 * written; the error handler adds Retry-After.
 */
const authBusyResponse = codedRefusal(
  "AUTH_BUSY: este servidor está com conferências de senha demais na fila agora (login, cadastro de usuário, definição ou troca de senha, código de dois fatores ou de exclusão). Nada foi gravado. Transitório: espere o `retry-after` e repita. Não é credencial errada nem fim da sessão.",
  ["AUTH_BUSY"],
);

export {
  GENERIC_CODE_DESCRIPTION,
  authBusyResponse,
  codeList,
  codedRefusal,
  codesOf,
  errorResponse,
  internalErrorResponse,
};
