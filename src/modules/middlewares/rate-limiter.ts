import { FastifyRequest } from "fastify";

import { AppError } from "@/shared/errors/AppError";
import { RateLimitOptions } from "@fastify/rate-limit";

export interface RateLimiterOptions extends RateLimitOptions {
  max?: number; // Maximum number of requests
  timeWindow?: number; // Time window (in milliseconds)
  message?: string;
}

const getRateLimiterConfig = (options?: RateLimiterOptions) => {
  return {
    // Defines the maximum number of requests; default 20 if not informed
    max: options?.max ?? 20,
    // Sets the time window in milliseconds; default 1 minute if not informed
    timeWindow: options?.timeWindow ?? 60 * 1000,
    // Do not skip any requests
    skip: (request: FastifyRequest) => false,
    // Generates the unique key for the client based on IP
    keyGenerator: (request: any) => {
      const clientIP =
        request.headers["cf-connecting-ip"] ||
        request.headers["x-real-ip"] ||
        request.headers["x-forwarded-for"] ||
        request.socket.remoteAddress;
      return clientIP || "";
    },
    // Configures the error response if the limit is exceeded
    errorResponseBuilder: (request: FastifyRequest, context: any) => {
      throw new AppError(
        options?.message ??
          "Muitas solicitações vindas deste IP! Por favor, tente novamente mais tarde.",
        429,
      );
    },
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
