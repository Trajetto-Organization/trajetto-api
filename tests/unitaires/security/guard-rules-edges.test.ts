import { describe, expect, it } from "vitest";

import { clientRateLimitKey } from "@/config/rate-limit";
import { readDriverUserIdPayload } from "@/modules/chat/usecases/shared/chat-access-rules";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";
import {
  canReactivateVehicle,
  canRegisterVehicle,
} from "@/shared/entitlements/entitlement-rules";
import { AppError } from "@/shared/errors/AppError";
import {
  KEY_NAMESPACE,
  RESERVED_API_SCOPES,
  SCOPE_DESCRIPTIONS,
  apiKeySecretMatches,
  hashApiKeySecret,
  parseApiKey,
  reservedScopesPhrase,
} from "@/shared/integration/api-key-rules";
import {
  FAILED_LOGIN_WINDOW_MS,
  LOGIN_LOCK_MS,
  afterFailedLogin,
  isLoginLocked,
} from "@/shared/security/login-lockout-rules";

/**
 * Edges of the security rules left alive by the 06/10 mutation run: API key
 * parsing and comparison, the reserved-scope sentence, the login lock's
 * boundaries, the per-route rate limiter's options and the chat hint's size.
 */

const SECRET_32 = "s".repeat(32);
const T = new Date("2026-10-06T12:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("parseApiKey", () => {
  it("splits a trimmed key whose secret has at least 32 characters", () => {
    expect(KEY_NAMESPACE).toBe("tjk_live");
    expect(parseApiKey(`  tjk_live_ab12.${SECRET_32}  `)).toEqual({
      prefix: "tjk_live_ab12",
      secret: SECRET_32,
    });
    expect(parseApiKey(`tjk_live_ab12.${SECRET_32.slice(1)}`)).toBeNull();
  });

  it("refuses a key without a separator or with nothing before it", () => {
    expect(parseApiKey(`tjk_live_ab12${SECRET_32}${SECRET_32}`)).toBeNull();
    expect(parseApiKey(`.tjk_live_${SECRET_32}`)).toBeNull();
  });
});

describe("apiKeySecretMatches", () => {
  it("matches the stored hash and refuses one of another length", () => {
    expect(apiKeySecretMatches(SECRET_32, hashApiKeySecret(SECRET_32))).toBe(
      true,
    );
    expect(apiKeySecretMatches(SECRET_32, "abcd")).toBe(false);
  });
});

describe("reserved scopes", () => {
  it("lists webhooks:manage alone, in a singular sentence", () => {
    expect(RESERVED_API_SCOPES).toEqual(["webhooks:manage"]);
    expect(reservedScopesPhrase()).toBe(
      "O escopo webhooks:manage está reservado",
    );
    expect(reservedScopesPhrase((scope) => `\`${scope}\``)).toBe(
      "O escopo `webhooks:manage` está reservado",
    );
  });

  it("describes every scope", () => {
    expect(SCOPE_DESCRIPTIONS).toEqual({
      "routes:read": "Ler rotas e suas paradas.",
      "deliveries:read": "Ler entregas e o histórico delas.",
      "deliveries:write":
        "Criar entregas (POST /integration/v1/deliveries), com Idempotency-Key obrigatória. Não inclui a leitura: para consultar, conceda também deliveries:read.",
      "events:read": "Ler o feed de eventos da operação.",
      "webhooks:manage":
        "Reservado para gerir webhooks por chave: nenhum endpoint da v1 exige este escopo ainda. Hoje os webhooks são geridos pelo painel.",
    });
  });
});

describe("the login lock", () => {
  it("lasts fifteen minutes and ends at its own instant", () => {
    expect(LOGIN_LOCK_MS).toBe(900_000);
    expect(isLoginLocked({ login_locked_until: T }, T)).toBe(false);
    expect(isLoginLocked({ login_locked_until: at(1) }, T)).toBe(true);
  });

  it("counts failures within an hour, including one exactly an hour old", () => {
    expect(FAILED_LOGIN_WINDOW_MS).toBe(3_600_000);
    expect(
      afterFailedLogin(
        { failed_login_attempts: 4, failed_login_at: at(-3_600_000) },
        T,
      ).failed_login_attempts,
    ).toBe(5);
    expect(
      afterFailedLogin(
        { failed_login_attempts: 4, failed_login_at: at(-3_600_001) },
        T,
      ).failed_login_attempts,
    ).toBe(1);
  });

  it("keeps an existing lock below the threshold", () => {
    const lockedUntil = at(60_000);

    expect(
      afterFailedLogin(
        {
          failed_login_attempts: 1,
          failed_login_at: at(-1000),
          login_locked_until: lockedUntil,
        },
        T,
      ).login_locked_until,
    ).toBe(lockedUntil);
  });
});

describe("getRateLimiterConfig", () => {
  it("defaults to 20 a minute by client, with the standard headers", () => {
    const config = getRateLimiterConfig();

    expect(config).toMatchObject({
      max: 20,
      timeWindow: 60_000,
      keyGenerator: clientRateLimitKey,
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true,
      },
      legacyHeaders: false,
    });
    expect(config).not.toHaveProperty("hook");
    expect(config.errorResponseBuilder()).toBeInstanceOf(AppError);
  });

  it("takes the route's own limit, window, key, hook and message", () => {
    const keyGenerator = () => "k";
    const config = getRateLimiterConfig({
      max: 3,
      timeWindow: 1000,
      keyGenerator,
      hook: "preHandler",
      message: "Calma.",
    });

    expect(config).toMatchObject({
      max: 3,
      timeWindow: 1000,
      keyGenerator,
      hook: "preHandler",
    });
    expect(config.errorResponseBuilder().message).toBe("Calma.");
  });
});

describe("readDriverUserIdPayload", () => {
  it("takes up to 64 characters from an object only", () => {
    expect(readDriverUserIdPayload({ driverUserId: "u".repeat(64) })).toBe(
      "u".repeat(64),
    );
    expect(
      readDriverUserIdPayload({ driverUserId: "u".repeat(65) }),
    ).toBeNull();
    expect(
      readDriverUserIdPayload(
        Object.assign(() => undefined, { driverUserId: "u1" }),
      ),
    ).toBeNull();
  });
});

describe("the vehicle quota", () => {
  it("says the count and what to do, for a new vehicle and for a reactivation", () => {
    expect(canRegisterVehicle(20, 20)).toEqual({
      allowed: false,
      reason:
        "Limite de veículos contratados atingido (20/20 ativos). Inative um veículo ou fale com o suporte para ampliar o plano da empresa.",
    });
    expect(canReactivateVehicle(20, 20)).toEqual({
      allowed: false,
      reason:
        "Limite de veículos contratados atingido (20/20 ativos). Para reativar este veículo, inative outro ou amplie o plano da empresa.",
    });
  });
});
