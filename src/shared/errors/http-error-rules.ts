import { AppError } from "./AppError";

/**
 * How a refusal becomes an HTTP answer (decision 11.3).
 *
 * The convention, for every module:
 *
 * - A domain error whose status never depends on the route extends AppError
 *   with its status and a stable code, and the controller lets it through:
 *   the global handler (http.ts) sends `{ code, message }` and `x-error-code`.
 * - Not found → 404 (`<THING>_NOT_FOUND`); another company's id gets the SAME
 *   answer as a missing one, so no caller can probe which ids exist.
 * - Conflict with the current state or a uniqueness rule → 409.
 * - A link named in the BODY that does not resolve is the request being wrong:
 *   400 with the thing's code. The resource in the PATH is what is missing: 404.
 * - Validation stays 400 VALIDATION_ERROR; a validation 400 never becomes 404.
 *
 * Only the route knows whether a link came from the body or the path, so a
 * controller whose answer depends on it lists rules and rethrows through
 * `toHttpError`. Nothing is sent inline: an inline body went through the
 * route's response schema and lost its `code` on the way.
 */
type ErrorClass = abstract new (...args: never[]) => Error;

/** [error class, status, code, sentence that replaces the error's own]. */
type HttpErrorRule = readonly [
  type: ErrorClass,
  status: number,
  code: string,
  message?: string,
];

/**
 * The error as the AppError a rule makes of it, or the error untouched when
 * no rule matches (an AppError keeps its own status and code; anything else
 * is the handler's 500). Rules win over an AppError's own status: that is how
 * a body link answers 400 where the same class answers 404 in a path.
 */
function toHttpError(error: unknown, rules: readonly HttpErrorRule[]): unknown {
  const rule = rules.find(([type]) => error instanceof type);

  if (!rule) return error;

  const [, status, code, message] = rule;

  return new AppError(message ?? (error as Error).message, status, code);
}

/** 404 with a code: the resource does not exist, or is another company's. */
class NotFoundError extends AppError {
  constructor(message: string, code: string) {
    super(message, 404, code);
    this.name = "NotFoundError";
  }
}

/** 409 with a code: a well-formed request the current state refuses. */
class ConflictError extends AppError {
  constructor(message: string, code: string) {
    super(message, 409, code);
    this.name = "ConflictError";
  }
}

/**
 * The code a 4xx body without one is given, from its status alone.
 *
 * A safety net, not the convention: every refusal is meant to carry its own
 * code. Published so the documents and the clients agree on the fallback.
 */
const STATUS_FALLBACK_CODES: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  410: "GONE",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
};

function fallbackCodeFor(status: number): string {
  return STATUS_FALLBACK_CODES[status] ?? "CLIENT_ERROR";
}

export {
  ConflictError,
  fallbackCodeFor,
  NotFoundError,
  STATUS_FALLBACK_CODES,
  toHttpError,
};
export type { ErrorClass, HttpErrorRule };
