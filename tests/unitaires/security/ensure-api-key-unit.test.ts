import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

/**
 * `ensureApiKey` and `verifyApiScope` at unit level (mutation run 06/10: only
 * E2E suites reached them, so almost every branch had no coverage in the
 * mutation run). The key repository, the module lookup and the client address
 * are stand-ins; the key parsing, the hash comparison, the throttle and the
 * refusals are the real ones.
 */

const entitlements = vi.hoisted(() => ({ hasModule: vi.fn() }));

vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);

vi.mock("@/config/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/rate-limit")>()),
  clientAddress: () => "203.0.113.9",
}));

import { ensureApiKey, verifyApiScope } from "@/modules/middlewares/ensure-api-key";
import { AppError } from "@/shared/errors/AppError";
import { hashApiKeySecret } from "@/shared/integration/api-key-rules";
import { configureIntegrationRateGuard } from "@/shared/integration/integration-rate-guard";

const SECRET = "s".repeat(40);
const PREFIX = "tjk_live_ab12cd";

const guard = { authFailuresBlocked: vi.fn(), recordAuthFailure: vi.fn(), allowBusiness: vi.fn() };
const repository = { findCredentialByPrefix: vi.fn(), touchLastUsed: vi.fn() };

let keySeq = 0;
const storedKey = (over: Record<string, unknown> = {}) => ({
  id: `key-${++keySeq}`,
  name: "ERP",
  prefix: PREFIX,
  businessId: "business-1",
  scopes: ["deliveries:read"],
  rate_limit_per_minute: 120,
  revoked_at: null,
  token_hash: hashApiKeySecret(SECRET),
  business: { is_active: true, timezone: "America/Manaus" },
  ...over,
});

const logger = () => {
  const log = { child: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
};

const call = (authorization?: string) => {
  const request = { headers: authorization ? { authorization } : {}, log: logger() } as Record<string, unknown>;
  const reply = { header: vi.fn(), log: logger() };
  return { request, reply, run: () => ensureApiKey(request as never, reply as never) };
};

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.statusCode, code: error.code, message: error.message };
  }
}

const INVALID = { status: 401, code: "INVALID_API_KEY", message: "Chave de API inválida." };

beforeEach(() => {
  guard.authFailuresBlocked.mockReset().mockResolvedValue(false);
  guard.recordAuthFailure.mockReset().mockResolvedValue(undefined);
  configureIntegrationRateGuard(guard);
  repository.findCredentialByPrefix.mockReset().mockResolvedValue(storedKey());
  repository.touchLastUsed.mockReset().mockResolvedValue(undefined);
  container.registerInstance("ApiKeyRepository", repository);
  entitlements.hasModule.mockReset().mockResolvedValue(true);
});

describe("ensureApiKey", () => {
  it("refuses an address over its failure budget with 429 and retry-after", async () => {
    guard.authFailuresBlocked.mockResolvedValue(true);
    const { reply, run } = call(`Bearer ${PREFIX}.${SECRET}`);

    expect(await refusalOf(run)).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      message: "Muitas tentativas com chave de API inválida. Confira a chave e tente novamente em um minuto.",
    });
    expect(guard.authFailuresBlocked).toHaveBeenCalledWith("ip:203.0.113.9");
    expect(reply.header).toHaveBeenCalledWith("retry-after", "60");
    expect(repository.findCredentialByPrefix).not.toHaveBeenCalled();
  });

  it("refuses, and counts against the address, every bad credential alike", async () => {
    const cases: Array<[string | undefined, () => void]> = [
      [undefined, () => undefined],
      [`Basic ${PREFIX}.${SECRET}`, () => undefined],
      ["Bearer not-a-key", () => undefined],
      [`Bearer ${PREFIX}.${SECRET}`, () => repository.findCredentialByPrefix.mockResolvedValueOnce(null)],
      [`Bearer ${PREFIX}.${SECRET}`, () => repository.findCredentialByPrefix.mockResolvedValueOnce(storedKey({ revoked_at: new Date() }))],
      [`Bearer ${PREFIX}.${"x".repeat(40)}`, () => undefined],
    ];

    for (const [authorization, arrange] of cases) {
      arrange();
      expect(await refusalOf(call(authorization).run)).toEqual(INVALID);
    }
    expect(guard.recordAuthFailure).toHaveBeenCalledTimes(cases.length);
    expect(guard.recordAuthFailure).toHaveBeenCalledWith("ip:203.0.113.9");
  });

  it("looks the key up by its prefix", async () => {
    await call(`Bearer ${PREFIX}.${SECRET}`).run();

    expect(repository.findCredentialByPrefix).toHaveBeenCalledWith(PREFIX);
  });

  it("refuses a key of a deactivated company or one without Entregas, with company codes", async () => {
    repository.findCredentialByPrefix.mockResolvedValueOnce(storedKey({ business: { is_active: false, timezone: "UTC" } }));
    expect(await refusalOf(call(`Bearer ${PREFIX}.${SECRET}`).run)).toEqual({
      status: 403,
      code: "TENANT_INACTIVE",
      message: "A empresa desta chave está desativada.",
    });

    entitlements.hasModule.mockResolvedValueOnce(false);
    expect(await refusalOf(call(`Bearer ${PREFIX}.${SECRET}`).run)).toEqual({
      status: 403,
      code: "MODULE_NOT_ENABLED",
      message: "O módulo de Entregas não está habilitado para a empresa desta chave.",
    });
    expect(entitlements.hasModule).toHaveBeenLastCalledWith("business-1", "DELIVERIES");
    expect(guard.recordAuthFailure).not.toHaveBeenCalled();
  });

  it("puts the key on the request, names it in the logs and records its use once per throttle", async () => {
    const key = storedKey();
    repository.findCredentialByPrefix.mockResolvedValue(key);

    const first = call(`Bearer ${PREFIX}.${SECRET}`);
    await first.run();
    await call(`Bearer ${PREFIX}.${SECRET}`).run();

    expect(first.request.apiKey).toEqual({
      id: key.id,
      name: "ERP",
      prefix: PREFIX,
      businessId: "business-1",
      scopes: ["deliveries:read"],
      rateLimitPerMinute: 120,
      timeZone: "America/Manaus",
    });
    expect((first.request.log as { child: ReturnType<typeof vi.fn> }).child).toHaveBeenCalledWith({
      apiKeyId: key.id,
      businessId: "business-1",
    });
    expect(first.reply.log.child).toHaveBeenCalledWith({ apiKeyId: key.id, businessId: "business-1" });
    expect(repository.touchLastUsed).toHaveBeenCalledTimes(1);
    expect(repository.touchLastUsed).toHaveBeenCalledWith(key.id, expect.any(Date));
  });

  it("forgets the throttle when recording the use fails, so the next call tries again", async () => {
    const key = storedKey();
    repository.findCredentialByPrefix.mockResolvedValue(key);
    repository.touchLastUsed.mockRejectedValueOnce(new Error("db busy"));

    await call(`Bearer ${PREFIX}.${SECRET}`).run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await call(`Bearer ${PREFIX}.${SECRET}`).run();

    expect(repository.touchLastUsed).toHaveBeenCalledTimes(2);
  });
});

describe("verifyApiScope", () => {
  const hook = verifyApiScope("deliveries:write");

  it("needs a key, then the scope, with distinct statuses", async () => {
    expect(await refusalOf(() => hook({} as never))).toEqual(INVALID);
    expect(await refusalOf(() => hook({ apiKey: { scopes: ["deliveries:read"] } } as never))).toEqual({
      status: 403,
      code: "MISSING_API_SCOPE",
      message: 'Esta chave não tem o escopo "deliveries:write".',
    });
    expect(await refusalOf(() => hook({ apiKey: { scopes: ["deliveries:write"] } } as never))).toBeNull();
  });

  it("publishes its scope for /docs", () => {
    expect(hook.openapi).toEqual({ scope: "deliveries:write" });
  });
});
