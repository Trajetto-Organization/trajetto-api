import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The anti-bot check on the public quote form, done by the API itself.
 *
 * Turnstile used to be verified only inside the web's server action, so the
 * API answered anyone who posted to it directly — which is exactly what a bot
 * does. The API now verifies the token the web forwards.
 *
 * Two switches, for a rollout that never breaks the web that is live:
 *   - with the secret set, a token that IS sent is verified;
 *   - with TURNSTILE_REQUIRED on, a request WITHOUT one is refused. Off by
 *     default, because the web deployed today verifies locally and does not
 *     forward its (single-use) token.
 */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function answer(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

async function load() {
  return import("@/shared/security/turnstile");
}

beforeEach(() => {
  clearLogged();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("with no secret configured", () => {
  it("lets the request through without calling Cloudflare", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("token", { secret: undefined, required: false }),
    ).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when enforcement is on, instead of silently skipping", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("token", { secret: undefined, required: true }),
    ).rejects.toMatchObject({ statusCode: 503, code: "TURNSTILE_UNAVAILABLE" });

    expect(fetch).not.toHaveBeenCalled();

    // The misconfiguration is named in the log, not just answered.
    expect(logged("error")).toHaveLength(1);
    expect(logged("error")[0]).toMatchObject({ component: "turnstile" });
  });
});

describe("with the secret configured", () => {
  const secret = "0x-test-secret";

  it("accepts a request with no token while enforcement is off (web still live)", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken(undefined, { secret, required: false }),
    ).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a request with no token once enforcement is on", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken(undefined, { secret, required: true }),
    ).rejects.toMatchObject({ statusCode: 400, code: "TURNSTILE_REQUIRED" });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies a token it was given, with the secret, at Cloudflare", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("the-token", { secret, required: false }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe(SITEVERIFY);
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(String(init.body));

    expect(body.get("secret")).toBe(secret);
    expect(body.get("response")).toBe("the-token");
  });

  it("refuses a token Cloudflare rejects, even with enforcement off", async () => {
    vi.stubGlobal(
      "fetch",
      answer({ success: false, "error-codes": ["invalid-input-response"] }),
    );

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("forged", { secret, required: false }),
    ).rejects.toMatchObject({ statusCode: 400, code: "TURNSTILE_FAILED" });

    // Why Cloudflare refused it, and never the token itself.
    expect(logged("warn")[0]).toMatchObject({
      errorCodes: ["invalid-input-response"],
    });
    expect(JSON.stringify(logged())).not.toContain("forged");
  });

  it("answers 503 when Cloudflare cannot be reached, and does not let it through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("the-token", { secret, required: false }),
    ).rejects.toMatchObject({ statusCode: 503, code: "TURNSTILE_UNAVAILABLE" });
  });

  it("answers 503 when Cloudflare answers with an error status", async () => {
    vi.stubGlobal("fetch", answer({}, 500));

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("the-token", { secret, required: false }),
    ).rejects.toMatchObject({ statusCode: 503, code: "TURNSTILE_UNAVAILABLE" });
  });
});
