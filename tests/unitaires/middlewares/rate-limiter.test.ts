import { describe, it, expect, vi, afterEach } from "vitest";
import { FastifyRequest } from "fastify";

import {
  getRateLimiterConfig,
  RateLimiterOptions,
} from "@/modules/middlewares/rate-limiter";
import { AppError } from "@/shared/errors/AppError";

describe("Get Rate Limiter Config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return default configuration when no options are provided", () => {
    const config = getRateLimiterConfig();

    expect(config.max).toBe(20);
    expect(config.timeWindow).toBe(60 * 1000);
  });

  it("should override default max and timeWindow when options are provided", () => {
    const options: RateLimiterOptions = { max: 50, timeWindow: 120000 };
    const config = getRateLimiterConfig(options);

    expect(config.max).toBe(50);
    expect(config.timeWindow).toBe(120000);
  });

  it("should not skip any requests", () => {
    const config = getRateLimiterConfig();
    const request = {} as FastifyRequest;

    expect(config.skip(request)).toBe(false);
  });

  it("should generate a unique key based on client IP", () => {
    const config = getRateLimiterConfig();

    const request = {
      headers: {
        "cf-connecting-ip": "1.2.3.4",
        "x-real-ip": "5.6.7.8",
        "x-forwarded-for": "9.10.11.12",
      },
      socket: { remoteAddress: "13.14.15.16" },
    } as unknown as FastifyRequest;

    expect(config.keyGenerator(request)).toBe("1.2.3.4");

    delete request.headers["cf-connecting-ip"];
    expect(config.keyGenerator(request)).toBe("5.6.7.8");

    delete request.headers["x-real-ip"];
    expect(config.keyGenerator(request)).toBe("9.10.11.12");

    delete request.headers["x-forwarded-for"];
    expect(config.keyGenerator(request)).toBe("13.14.15.16");
  });

  it("should return an empty string if client IP is not available", () => {
    const config = getRateLimiterConfig();
    const request = {
      headers: {},
      socket: { remoteAddress: null },
    } as unknown as FastifyRequest;

    expect(config.keyGenerator(request)).toBe("");
  });

  it("should throw AppError with status 429 when rate limit is exceeded", () => {
    const config = getRateLimiterConfig();
    const request = {} as FastifyRequest;

    try {
      config.errorResponseBuilder(request, {});
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe(
        "Muitas solicitações vindas deste IP! Por favor, tente novamente mais tarde.",
      );

      expect(error.statusCode).toBe(429);
    }
  });

  it("should add rate limiting headers", () => {
    const config = getRateLimiterConfig();

    expect(config.addHeaders).toEqual({
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    });
  });

  it("should disable legacy headers", () => {
    const config = getRateLimiterConfig();
    expect(config.legacyHeaders).toBe(false);
  });
});
