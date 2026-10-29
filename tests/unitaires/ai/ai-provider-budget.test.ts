import { describe, expect, it, vi } from "vitest";

/**
 * An AI unit fits in the lease that protects it (INV-09, ST-06, GAP2-2), and
 * the reader is the one the environment names (ADR 0010, 05/10/2026).
 *
 * The old Anthropic client was built with the SDK defaults: a 10-minute
 * timeout and 2 retries, up to ~30 minutes for ONE call against a 5-minute
 * lease. The local OCR reader gets 15 s and no client retry.
 */
vi.mock("@/env", () => ({
  env: {
    AI_PROVIDER: "local",
    AI_LOCAL_URL: "http://trajetto-ai:8080",
    AI_LOCAL_TOKEN: "t".repeat(40),
    AI_LOCAL_TIMEOUT_MS: 15_000,
    AI_LOCAL_MAX_CONCURRENCY: 1,
    UPLOAD_STORAGE_TYPE: "local",
  },
}));

describe("the configured reader", () => {
  it("is the local OCR service: 15 s per call, no client retry, one read in flight", async () => {
    const { createConfiguredImageReader } = await import(
      "@/shared/ai/ai-provider"
    );

    const reader = createConfiguredImageReader({
      AI_PROVIDER: "local",
      AI_LOCAL_URL: "http://trajetto-ai:8080",
      AI_LOCAL_TOKEN: "t".repeat(40),
    });

    expect(reader?.name).toBe("local");
    expect(reader?.timeoutMs).toBe(15_000);
    expect(reader?.maxRetries).toBe(0);
    expect(reader?.maxConcurrency).toBe(1);
  });

  it("reads only the receipt and the odometer: the other checklist items are not OCR questions", async () => {
    const { createConfiguredImageReader } = await import(
      "@/shared/ai/ai-provider"
    );

    const reader = createConfiguredImageReader({
      AI_PROVIDER: "local",
      AI_LOCAL_URL: "http://trajetto-ai:8080",
      AI_LOCAL_TOKEN: "t".repeat(40),
    })!;

    expect(reader.supports("proof")).toBe(true);
    expect(reader.supports("odometer")).toBe(true);
    expect(reader.supports("fuel_level")).toBe(false);
    expect(reader.supports("condition")).toBe(false);
    expect(reader.supports("working")).toBe(false);
  });

  it("is switched off by AI_PROVIDER=none, and by a missing URL or token", async () => {
    const { aiProviderConfigured, createConfiguredImageReader } = await import(
      "@/shared/ai/ai-provider"
    );

    const config = {
      AI_PROVIDER: "local" as const,
      AI_LOCAL_URL: "http://trajetto-ai:8080",
      AI_LOCAL_TOKEN: "t".repeat(40),
    };

    expect(aiProviderConfigured(config)).toBe(true);

    expect(
      createConfiguredImageReader({ ...config, AI_PROVIDER: "none" }),
    ).toBeNull();
    expect(aiProviderConfigured({ ...config, AI_PROVIDER: "none" })).toBe(
      false,
    );
    expect(aiProviderConfigured({ ...config, AI_LOCAL_TOKEN: "" })).toBe(false);
    expect(aiProviderConfigured({ ...config, AI_LOCAL_URL: undefined })).toBe(
      false,
    );
    expect(
      createConfiguredImageReader({ ...config, AI_LOCAL_TOKEN: undefined }),
    ).toBeNull();
  });
});

describe("the environment", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  };

  it("refuses a leftover AI_PROVIDER=anthropic with the reason, instead of switching the AI off", async () => {
    const { envSchema } = await import("@/schemas/env-schema");

    const parsed = envSchema.safeParse({ ...base, AI_PROVIDER: "anthropic" });

    expect(parsed.success).toBe(false);
    expect(
      parsed.success
        ? ""
        : parsed.error.issues.map((issue) => issue.message).join(" "),
    ).toMatch(/anthropic foi removido \(ADR 0010\)/);
  });

  it("defaults to the local reader with the 15 s budget and one read per replica", async () => {
    const { envSchema } = await import("@/schemas/env-schema");

    const parsed = envSchema.safeParse(base);

    // Other required variables may be missing here; only the AI keys matter.
    const issues = parsed.success
      ? []
      : parsed.error.issues.filter((issue) =>
          String(issue.path[0]).startsWith("AI_"),
        );

    expect(issues).toEqual([]);

    if (parsed.success) {
      expect(parsed.data.AI_PROVIDER).toBe("local");
      expect(parsed.data.AI_LOCAL_TIMEOUT_MS).toBe(15_000);
      expect(parsed.data.AI_LOCAL_MAX_CONCURRENCY).toBe(1);
    }
  });

  it("refuses a token too short to be a secret and a concurrency the service cannot take", async () => {
    const { envSchema } = await import("@/schemas/env-schema");

    const parsed = envSchema.safeParse({
      ...base,
      AI_LOCAL_TOKEN: "short",
      AI_LOCAL_MAX_CONCURRENCY: "9",
    });

    const paths = parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.path[0]);

    expect(paths).toContain("AI_LOCAL_TOKEN");
    expect(paths).toContain("AI_LOCAL_MAX_CONCURRENCY");
  });
});

describe("the AI lease invariant", () => {
  it("holds for the local reader's budget", async () => {
    const { LOCAL_AI_DEFAULT_TIMEOUT_MS, LOCAL_AI_MAX_RETRIES } = await import(
      "@/shared/ai/ai-provider-defaults"
    );
    const { AI_IMAGE_FETCH_TIMEOUT_MS } = await import(
      "@/shared/ai/ai-provider"
    );
    const { AI_CLAIM_LEASE_SECONDS, assertAILeaseInvariant } = await import(
      "@/shared/ai/ai-rules"
    );

    expect(() =>
      assertAILeaseInvariant({
        providerTimeoutMs: LOCAL_AI_DEFAULT_TIMEOUT_MS,
        providerMaxRetries: LOCAL_AI_MAX_RETRIES,
        imageFetchTimeoutMs: AI_IMAGE_FETCH_TIMEOUT_MS,
        leaseSeconds: AI_CLAIM_LEASE_SECONDS,
      }),
    ).not.toThrow();
  });

  it("refuses an AI_LOCAL_TIMEOUT_MS that does not fit in the lease", async () => {
    const { assertAILeaseInvariant } = await import("@/shared/ai/ai-rules");

    expect(() =>
      assertAILeaseInvariant({
        providerTimeoutMs: 290_000,
        providerMaxRetries: 0,
        imageFetchTimeoutMs: 15_000,
        leaseSeconds: 300,
      }),
    ).toThrow(/does not fit in the 300s lease/);
  });

  it("refuses the SDK defaults the old client used to run with", async () => {
    const { assertAILeaseInvariant } = await import("@/shared/ai/ai-rules");

    expect(() =>
      assertAILeaseInvariant({
        providerTimeoutMs: 600_000,
        providerMaxRetries: 2,
        imageFetchTimeoutMs: 15_000,
        leaseSeconds: 300,
      }),
    ).toThrow(/does not fit in the 300s lease/);
  });
});
