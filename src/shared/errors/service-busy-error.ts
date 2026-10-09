import { AppError } from "./AppError";

/**
 * Refused because of load, not because of the request.
 *
 * A 503 with `Retry-After`: the caller did nothing wrong and the same request
 * will work in a moment. The app (utils/api.ts) and the web already show the
 * `message` of any non-OK answer, and the app honours `Retry-After` on a 503.
 */
class ServiceBusyError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, code: string, retryAfterSeconds: number) {
    super(message, 503, code);

    this.name = "ServiceBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export { ServiceBusyError };
