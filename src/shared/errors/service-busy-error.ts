import { AppError } from "./AppError";

/**
 * Refused because of load, not because of the request.
 *
 * A 503 with `Retry-After`: the caller did nothing wrong and the same request
 * will work in a moment. The app (utils/api.ts) and the web already show the
 * `message` of any non-OK answer, and the app honours `Retry-After` on a 503.
 * A 429 when what is full is the caller's own share (EXPORT_BUSY: their
 * company already has an export running), still with `Retry-After`.
 *
 * `diagnostic` says why, for whoever reads the log: the variable that is
 * missing, what a provider's refusal means (ADDRESS_SEARCH_DISABLED, the
 * search's pauses). It never reaches the body — sendError writes only the
 * code and the message — and pino's err serializer writes it on the
 * "Request rejected" line (http.ts), because it is the error's own field.
 * Never a secret, a URL or what a person typed.
 */
class ServiceBusyError extends AppError {
  readonly retryAfterSeconds: number;
  readonly diagnostic: string | undefined;

  constructor(
    message: string,
    code: string,
    retryAfterSeconds: number,
    statusCode: 429 | 503 = 503,
    diagnostic?: string,
  ) {
    super(message, statusCode, code);

    this.name = "ServiceBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.diagnostic = diagnostic;
  }
}

export { ServiceBusyError };
