import { clientRateLimitKey, rateLimitExceeded } from "@/config/rate-limit";
import { RateLimitOptions } from "@fastify/rate-limit";

export interface RateLimiterOptions extends RateLimitOptions {
  max?: number; // Maximum number of requests
  timeWindow?: number; // Time window (in milliseconds)
  message?: string;
}

const getRateLimiterConfig = (options?: RateLimiterOptions) => {
  // Same key and same refusal as the global limiter — see config/rate-limit —
  // unless the route has a better notion of "who" than the address.
  return {
    // Defines the maximum number of requests; default 20 if not informed
    max: options?.max ?? 20,
    // Sets the time window in milliseconds; default 1 minute if not informed
    timeWindow: options?.timeWindow ?? 60 * 1000,
    keyGenerator: options?.keyGenerator ?? clientRateLimitKey,
    // A key read from the BODY needs the body parsed: the default hook,
    // onRequest, runs before that.
    ...(options?.hook ? { hook: options.hook } : {}),
    errorResponseBuilder: () => rateLimitExceeded(options?.message),
    // Add rate limiting headers
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    // Disable legacy headers
    legacyHeaders: false,
  };
};

export { getRateLimiterConfig };
