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
 * One switch, the secret:
 *   - without it, Turnstile is off and every request passes;
 *   - with it, a request WITHOUT a token is refused and one WITH a token is
 *     verified at Cloudflare. The web forwards its (single-use) token.
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
      verifyTurnstileToken("token", { secret: undefined }),
    ).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("with the secret configured", () => {
  const secret = "0x-test-secret";

  it.each([undefined, null, ""])(
    "refuses a request with no token (%j) without calling Cloudflare",
    async (token) => {
      const fetch = answer({ success: true });
      vi.stubGlobal("fetch", fetch);

      const { verifyTurnstileToken } = await load();

      await expect(
        verifyTurnstileToken(token, { secret }),
      ).rejects.toMatchObject({ statusCode: 400, code: "TURNSTILE_REQUIRED" });

      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("verifies a token it was given, with the secret, at Cloudflare", async () => {
    const fetch = answer({ success: true });
    vi.stubGlobal("fetch", fetch);

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("the-token", { secret }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe(SITEVERIFY);
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(String(init.body));

    expect(body.get("secret")).toBe(secret);
    expect(body.get("response")).toBe("the-token");
  });

  it("refuses a token Cloudflare rejects", async () => {
    vi.stubGlobal(
      "fetch",
      answer({ success: false, "error-codes": ["invalid-input-response"] }),
    );

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("forged", { secret }),
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
      verifyTurnstileToken("the-token", { secret }),
    ).rejects.toMatchObject({ statusCode: 503, code: "TURNSTILE_UNAVAILABLE" });
  });

  it("answers 503 when Cloudflare answers with an error status", async () => {
    vi.stubGlobal("fetch", answer({}, 500));

    const { verifyTurnstileToken } = await load();

    await expect(
      verifyTurnstileToken("the-token", { secret }),
    ).rejects.toMatchObject({ statusCode: 503, code: "TURNSTILE_UNAVAILABLE" });
  });
});
