import { describe, expect, it } from "vitest";

import {
  checkAiOcr,
  checkEmail,
  checkHeartbeat,
  checkProofCertificate,
  checkProviders,
  checkPush,
  checkStorage,
  checkWhatsApp,
  type ReadinessDeps,
  type ReadinessEnv,
} from "@/shared/health/provider-readiness";

/**
 * Provider readiness (contract §32/§33): "just set the env vars" has to be
 * verifiable. Each provider's verdict is decided from what the provider's own
 * API answers — faked here at the HTTP boundary, which is the provider, not
 * the code under test — and the report never carries a credential.
 */

const SECRETS = {
  RESEND_SECRET_KEY: "re_live_SECRET_resend_key",
  META_WHATSAPP_ACCESS_TOKEN: "EAAG_SECRET_meta_token",
  META_WHATSAPP_APP_SECRET: "SECRET_app_secret",
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: "SECRET_verify",
  R2_SECRET_ACCESS_KEY: "SECRET_r2_key",
  R2_ACCESS_KEY_ID: "SECRET_r2_id",
  AI_LOCAL_TOKEN: "SECRET_ai_token_0123456789abcdef0123",
  HEALTHCHECK_PING_URL: "https://hc-ping.com/SECRET-uuid",
};

function fullEnv(overrides: Partial<ReadinessEnv> = {}): ReadinessEnv {
  return {
    NODE_ENV: "production",
    RESEND_FROM_EMAIL: "Trajetto <nao-responda@intrajetto.com>",
    RESEND_WEBHOOK_SECRET: "whsec_SECRET",
    META_WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    META_WHATSAPP_TEMPLATE_NAME: "trajetto_notification",
    META_WHATSAPP_CUSTOMER_TEMPLATE_NAME: "trajetto_cliente",
    META_WHATSAPP_API_VERSION: "v23.0",
    META_WHATSAPP_BUSINESS_ACCOUNT_ID: "998877665544",
    UPLOAD_STORAGE_TYPE: "r2",
    R2_ACCOUNT_ID: "acc",
    R2_BUCKET_NAME: "trajetto-uploads",
    AI_PROVIDER: "local",
    AI_LOCAL_URL: "http://trajetto-ai:8080",
    ...SECRETS,
    ...overrides,
  };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deps(
  routes: Record<string, Route>,
  overrides: Partial<ReadinessDeps> = {},
): ReadinessDeps {
  const calls: string[] = [];

  return {
    env: fullEnv(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);

      const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));

      if (!key)
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        });

      return routes[key](url, init);
    }) as typeof fetch,
    headBucket: async () => undefined,
    proofHealth: () => ({
      state: "READY",
      reason: null,
      not_after: "2027-06-01T00:00:00.000Z",
      days_left: 237,
    }),
    heartbeat: () => null,
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    timeoutMs: 200,
    ...overrides,
  };
}

const HEALTHY: Record<string, Route> = {
  "https://api.resend.com/domains": () =>
    json(200, { data: [{ name: "intrajetto.com", status: "verified" }] }),
  "https://graph.facebook.com/v23.0/1234567890": () =>
    json(200, {
      display_phone_number: "+55 11 4000-0000",
      verified_name: "Trajetto",
      quality_rating: "GREEN",
    }),
  "https://graph.facebook.com/v23.0/998877665544/message_templates?name=trajetto_notification":
    () =>
      json(200, {
        data: [
          {
            name: "trajetto_notification",
            status: "APPROVED",
            language: "pt_BR",
          },
        ],
      }),
  "https://graph.facebook.com/v23.0/998877665544/message_templates?name=trajetto_cliente":
    () =>
      json(200, {
        data: [
          { name: "trajetto_cliente", status: "APPROVED", language: "pt_BR" },
        ],
      }),
  "https://exp.host/--/api/v2/push/getReceipts": () => json(200, { data: {} }),
  "http://trajetto-ai:8080/health": () =>
    json(200, { ok: true, engine: "rapidocr", engineVersion: "3.9.2" }),
  "http://trajetto-ai:8080/v1/read": () =>
    json(400, { error: "unknown_profile" }),
};

describe("a fully configured production", () => {
  it("reports every provider ready, and no credential anywhere in the report", async () => {
    const report = await checkProviders(
      deps(HEALTHY, {
        heartbeat: () => ({
          at: "2026-10-07T11:59:00.000Z",
          healthy: true,
          delivered: true,
          http_status: 200,
        }),
      }),
    );

    expect(report.providers.map((p) => [p.key, p.status])).toEqual([
      ["email", "ok"],
      ["whatsapp", "ok"],
      ["push", "ok"],
      ["storage", "ok"],
      ["ai_ocr", "ok"],
      ["proof_certificate", "ok"],
      ["heartbeat", "ok"],
    ]);

    const body = JSON.stringify(report);

    for (const secret of Object.values(SECRETS))
      expect(body).not.toContain(secret);
    expect(body).not.toContain("hc-ping.com");
    expect(body).not.toContain("trajetto-ai:8080");
  });
});

describe("e-mail (Resend)", () => {
  it("names the missing variables, never their values", async () => {
    const result = await checkEmail(
      deps(HEALTHY, { env: fullEnv({ RESEND_SECRET_KEY: undefined }) }),
    );

    expect(result.status).toBe("not_configured");
    expect(result.missing_env).toEqual(["RESEND_SECRET_KEY"]);
  });

  it("is an error when the sender's domain is not verified", async () => {
    const result = await checkEmail(
      deps({
        "https://api.resend.com/domains": () =>
          json(200, { data: [{ name: "intrajetto.com", status: "pending" }] }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.details.domain_status).toBe("pending");
  });

  it("accepts a sending-only key, which cannot list domains", async () => {
    const result = await checkEmail(
      deps({
        "https://api.resend.com/domains": () =>
          json(401, { name: "restricted_api_key" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.reachable).toBe(true);
  });

  it("is an error when Resend refuses the key", async () => {
    const result = await checkEmail(
      deps({
        "https://api.resend.com/domains": () =>
          json(401, { name: "validation_error" }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("RESEND_SECRET_KEY");
  });

  it("warns when the receipts webhook secret is missing", async () => {
    const result = await checkEmail(
      deps(HEALTHY, { env: fullEnv({ RESEND_WEBHOOK_SECRET: undefined }) }),
    );

    expect(result.status).toBe("warning");
  });

  it("is off outside production, where mail goes to Ethereal", async () => {
    const result = await checkEmail(
      deps(HEALTHY, { env: fullEnv({ NODE_ENV: "development" }) }),
    );

    expect(result.status).toBe("disabled");
  });
});

describe("WhatsApp (Meta)", () => {
  it("says the token was refused (code 190)", async () => {
    const result = await checkWhatsApp(
      deps({
        "https://graph.facebook.com/v23.0/1234567890": () =>
          json(401, {
            error: { code: 190, message: "Error validating access token" },
          }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.details.meta_code).toBe(190);
    expect(result.message).toContain("META_WHATSAPP_ACCESS_TOKEN");
  });

  it("is an error when a template is not approved", async () => {
    const result = await checkWhatsApp(
      deps({
        ...HEALTHY,
        "https://graph.facebook.com/v23.0/998877665544/message_templates?name=trajetto_cliente":
          () =>
            json(200, {
              data: [
                {
                  name: "trajetto_cliente",
                  status: "PAUSED",
                  language: "pt_BR",
                },
              ],
            }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.details["template:trajetto_cliente"]).toBe("PAUSED");
    expect(result.details["template:trajetto_notification"]).toBe("APPROVED");
  });

  it("is an error when a template does not exist", async () => {
    const result = await checkWhatsApp(
      deps({
        ...HEALTHY,
        "https://graph.facebook.com/v23.0/998877665544/message_templates?name=trajetto_cliente":
          () => json(200, { data: [] }),
      }),
    );

    expect(result.details["template:trajetto_cliente"]).toBe("MISSING");
    expect(result.status).toBe("error");
  });

  it("cannot judge the templates without the business account id, and says which variable", async () => {
    const result = await checkWhatsApp(
      deps(HEALTHY, {
        env: fullEnv({ META_WHATSAPP_BUSINESS_ACCOUNT_ID: undefined }),
      }),
    );

    expect(result.status).toBe("warning");
    expect(result.details["template:trajetto_notification"]).toBe("UNKNOWN");
    expect(result.warnings.join(" ")).toContain(
      "META_WHATSAPP_BUSINESS_ACCOUNT_ID",
    );
  });

  it("is unreachable, not refused, when Meta does not answer", async () => {
    const result = await checkWhatsApp(deps({}));

    expect(result.status).toBe("error");
    expect(result.reachable).toBe(false);
  });
});

describe("push, storage, OCR, certificate and heartbeat", () => {
  it("push is an error when Expo answers 5xx", async () => {
    const result = await checkPush(
      deps({ "https://exp.host": () => json(503, {}) }),
    );

    expect(result.status).toBe("error");
  });

  it("storage says the credential was refused on a 403", async () => {
    const result = await checkStorage(
      deps(HEALTHY, {
        headBucket: async () => {
          throw Object.assign(new Error("Forbidden"), {
            $metadata: { httpStatusCode: 403 },
          });
        },
      }),
    );

    expect(result.status).toBe("error");
    expect(result.details.http_status).toBe(403);
  });

  it("local storage in production is an error", async () => {
    const result = await checkStorage(
      deps(HEALTHY, { env: fullEnv({ UPLOAD_STORAGE_TYPE: "local" }) }),
    );

    expect(result.status).toBe("error");
  });

  it("the OCR service with a wrong token is an error", async () => {
    const result = await checkAiOcr(
      deps({
        ...HEALTHY,
        "http://trajetto-ai:8080/v1/read": () =>
          json(401, { error: "unauthorized" }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("AI_LOCAL_TOKEN");
  });

  // "No route" used to cover every network failure, so a wrong App Name, a
  // stopped service and a dropped connection all read the same on the panel.
  it("an unreachable OCR service names the host it tried and the network error", async () => {
    const result = await checkAiOcr(deps({}));

    expect(result.status).toBe("error");
    expect(result.reachable).toBe(false);
    expect(result.message).toContain("trajetto-ai:8080");
    expect(result.message).toContain("ENOTFOUND");
    expect(result.message).toContain("App Name");
    expect(result.message).not.toContain(SECRETS.AI_LOCAL_TOKEN);
  });

  it("an OCR service that answers /health but drops the token check says which step failed", async () => {
    const result = await checkAiOcr(
      deps({
        "http://trajetto-ai:8080/health":
          HEALTHY["http://trajetto-ai:8080/health"],
        "http://trajetto-ai:8080/v1/read": () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNRESET" },
          });
        },
      }),
    );

    expect(result.status).toBe("error");
    expect(result.reachable).toBe(true);
    expect(result.message).toContain("/health");
    expect(result.message).toContain("ECONNRESET");
  });

  // Staging showed only "UND_ERR_INVALID_ARG": the code alone did not say
  // which argument undici refused. The message carries the cause's own text
  // (never the token, which no fetch error message contains).
  it("a refused token check names the error's own words, not only its code", async () => {
    const result = await checkAiOcr(
      deps({
        "http://trajetto-ai:8080/health":
          HEALTHY["http://trajetto-ai:8080/health"],
        "http://trajetto-ai:8080/v1/read": () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: {
              code: "UND_ERR_INVALID_ARG",
              message: "invalid content-length header",
            },
          });
        },
      }),
    );

    expect(result.message).toContain("UND_ERR_INVALID_ARG");
    expect(result.message).toContain("invalid content-length header");
    expect(result.message).not.toContain(SECRETS.AI_LOCAL_TOKEN);
  });

  // The token check is shaped like a real reading: fetch sets the length of
  // an empty body itself. A hand-written Content-Length was the one thing the
  // probe did that the working readings do not.
  it("checks the token without a hand-written Content-Length", async () => {
    let sent: Headers | null = null;

    await checkAiOcr(
      deps({
        ...HEALTHY,
        "http://trajetto-ai:8080/v1/read": (_url, init) => {
          sent = new Headers(init?.headers);

          return json(400, { error: "unknown_profile" });
        },
      }),
    );

    expect(sent).not.toBeNull();
    expect(sent!.has("content-length")).toBe(false);
    expect(sent!.get("authorization")).toBe(`Bearer ${SECRETS.AI_LOCAL_TOKEN}`);
  });

  it("the OCR service warming up is a warning", async () => {
    const result = await checkAiOcr(
      deps({
        "http://trajetto-ai:8080/health": () =>
          json(503, { ok: false, error: "warming_up" }),
      }),
    );

    expect(result.status).toBe("warning");
  });

  it("AI_PROVIDER=none is off, not broken", async () => {
    const result = await checkAiOcr(
      deps(HEALTHY, { env: fullEnv({ AI_PROVIDER: "none" }) }),
    );

    expect(result.status).toBe("disabled");
  });

  it("a certificate 20 days from its end is a warning; an expired one an error", () => {
    expect(
      checkProofCertificate(
        deps(
          {},
          {
            proofHealth: () => ({
              state: "READY",
              reason: null,
              not_after: null,
              days_left: 20,
            }),
          },
        ),
      ).status,
    ).toBe("warning");

    expect(
      checkProofCertificate(
        deps(
          {},
          {
            proofHealth: () => ({
              state: "EXPIRED",
              reason: null,
              not_after: null,
              days_left: -1,
            }),
          },
        ),
      ).status,
    ).toBe("error");
  });

  it("the heartbeat without its URL is not configured", () => {
    const result = checkHeartbeat(
      deps({}, { env: fullEnv({ HEALTHCHECK_PING_URL: undefined }) }),
    );

    expect(result.status).toBe("not_configured");
    expect(result.missing_env).toEqual(["HEALTHCHECK_PING_URL"]);
  });

  it("a recent ping the check refused is an error", () => {
    const result = checkHeartbeat(
      deps(
        {},
        {
          heartbeat: () => ({
            at: "2026-10-07T11:59:00.000Z",
            healthy: true,
            delivered: false,
            http_status: 404,
          }),
        },
      ),
    );

    expect(result.status).toBe("error");
    expect(result.details.last_ping_http_status).toBe(404);
  });
});
