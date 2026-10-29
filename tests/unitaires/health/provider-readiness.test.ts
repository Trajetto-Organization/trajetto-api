import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROBE_ATTEMPT_TIMEOUT_MS,
  PROBE_BUDGET_MS,
  PROBE_RETRY_DELAY_MS,
  READINESS_CACHE_MS,
  READINESS_TRANSIENT_CACHE_MS,
  checkAiOcr,
  checkEmail,
  checkHeartbeat,
  checkProofCertificate,
  checkProviders,
  checkPush,
  checkStorage,
  checkWhatsApp,
  readinessCache,
  readinessTtl,
  type ProviderReadinessReport,
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
    retryDelayMs: 5,
    log: { warn: () => undefined, info: () => undefined },
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

  it("never reads a template list that arrived cut or malformed as 'does not exist'", async () => {
    for (const answer of [
      () =>
        new Response('{"data":[{"name":"trajetto_cli', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => json(200, { error: { code: 1 } }),
      () => json(200, null),
    ]) {
      const result = await checkWhatsApp(
        deps({
          ...HEALTHY,
          "https://graph.facebook.com/v23.0/998877665544/message_templates?name=trajetto_cliente":
            answer,
        }),
      );

      expect(result.details["template:trajetto_cliente"]).toBe("UNKNOWN");
      expect(result.status).toBe("warning");
      expect(result.message).not.toContain("não existe");
      expect(result.warnings.join(" ")).toContain("trajetto_cliente");
    }
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

/**
 * The Sistema screen waits for the slowest provider, so independent probes
 * run side by side: Meta's number and each template, the OCR service's
 * /health and its token check. In sequence a provider having a bad minute
 * held the page for the sum of their timeouts (5 s each, then).
 */
describe("independent probes of one provider", () => {
  /** Every route answers after `ms`; records when each request started. */
  function slow(ms: number) {
    const started: Array<{ url: string; at: number }> = [];
    const routes: Record<string, Route> = {};

    for (const [prefix, route] of Object.entries(HEALTHY)) {
      routes[prefix] = async (url, init) => {
        started.push({ url, at: performance.now() });
        await new Promise((resolve) => setTimeout(resolve, ms));

        return route(url, init);
      };
    }

    return { routes, started };
  }

  it("asks Meta for the number and every template at the same time", async () => {
    const { routes, started } = slow(80);
    const begin = performance.now();

    const whatsapp = await checkWhatsApp(deps(routes, { timeoutMs: 2_000 }));

    expect(whatsapp.status).toBe("ok");
    expect(started.filter((call) => call.url.includes("graph"))).toHaveLength(
      3,
    );
    // One round trip, not three.
    expect(performance.now() - begin).toBeLessThan(200);
  });

  it("checks the OCR token while /health is still answering", async () => {
    const { routes, started } = slow(80);
    const begin = performance.now();

    const ocr = await checkAiOcr(deps(routes, { timeoutMs: 2_000 }));

    expect(ocr.status).toBe("ok");
    expect(started.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/health",
      "/v1/read",
    ]);
    expect(performance.now() - begin).toBeLessThan(150);
  });

  it("still reports /health's failure first when both fail", async () => {
    const report = await checkAiOcr(deps({}, { timeoutMs: 2_000 }));

    expect(report).toMatchObject({ status: "error", reachable: false });
    expect(report.message).toContain("ENOTFOUND");
  });
});

/**
 * §12: R2 and Resend sometimes read "Com erro" and were fine on the next
 * refresh. One failed attempt (a lost DNS packet, a reset, a 5xx, a body cut
 * short) used to be the verdict, pinned for 30 s on every replica. Now a
 * failure that may clear by itself gets ONE more attempt inside the
 * provider's budget, a recovered or slow answer is "warning" + transient,
 * two failures in a row stay "error", and a definitive answer is never
 * repeated nor softened.
 */
describe("transient failures, retry and budget", () => {
  /** Production timings (3.5 s per attempt, 5 s per provider). */
  const PRODUCTION_TIMING: Partial<ReadinessDeps> = {
    timeoutMs: undefined,
    budgetMs: undefined,
    retryDelayMs: undefined,
    slowMs: undefined,
  };

  const VERIFIED = () =>
    json(200, { data: [{ name: "intrajetto.com", status: "verified" }] });

  function useFakeClock() {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance", "Date"],
    });
  }

  function after(ms: number, answer: () => Response): Promise<Response> {
    return new Promise((resolve) => setTimeout(() => resolve(answer()), ms));
  }

  const never = () => new Promise<Response>(() => {});

  /** A 200 whose body starts and never ends. */
  function stalledBody(): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function resetError(code = "ECONNRESET") {
    return Object.assign(new TypeError("fetch failed"), { cause: { code } });
  }

  /** Answers each call with the next answer; the last one repeats. */
  function sequence(...answers: Array<() => Response | Promise<Response>>) {
    let call = 0;

    return vi.fn(() => {
      const answer = answers[Math.min(call, answers.length - 1)];

      call += 1;

      return answer();
    });
  }

  function recordingLog() {
    const warn = vi.fn();
    const info = vi.fn();

    return { log: { warn, info }, warn, info };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("e-mail (Resend)", () => {
    it("is unstable, not an error, when it answers after a lost DNS packet (2.6 s)", async () => {
      useFakeClock();

      const pending = checkEmail(
        deps(
          { "https://api.resend.com/domains": () => after(2_600, VERIFIED) },
          PRODUCTION_TIMING,
        ),
      );

      await vi.advanceTimersByTimeAsync(2_600);
      const result = await pending;

      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 1,
        failure_kind: null,
        latency_ms: 2_600,
      });
      expect(result.warnings.join(" ")).toContain("Respondeu em 2,6 s");
    });

    it("recovers on the second attempt after a reset, and logs the cause code", async () => {
      const route = sequence(() => {
        throw resetError();
      }, VERIFIED);
      const { log, warn, info } = recordingLog();

      const result = await checkEmail(
        deps({ "https://api.resend.com/domains": route }, { log }),
      );

      expect(route).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 2,
        failure_kind: "network",
        reachable: true,
      });
      expect(result.warnings).toContain(
        "A 1ª tentativa falhou (falha de rede); a 2ª respondeu.",
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "email",
          attempt: 1,
          kind: "network",
          code: "ECONNRESET",
          phase: "response",
          will_retry: true,
        }),
        "provider probe attempt failed",
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "email", attempts: 2 }),
        "provider probe recovered on retry",
      );
    });

    it("retries a timeout inside the budget and recovers", async () => {
      useFakeClock();

      const startedAt: number[] = [];
      const route = sequence(
        () => {
          startedAt.push(performance.now());

          return never();
        },
        () => {
          startedAt.push(performance.now());

          return VERIFIED();
        },
      );

      const begin = performance.now();
      const pending = checkEmail(
        deps({ "https://api.resend.com/domains": route }, PRODUCTION_TIMING),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const result = await pending;

      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 2,
        failure_kind: "timeout",
      });
      // The second attempt starts after the first one's deadline and the pause.
      expect(startedAt.map((at) => at - begin)).toEqual([
        0,
        PROBE_ATTEMPT_TIMEOUT_MS + PROBE_RETRY_DELAY_MS,
      ]);
    });

    it("is an error after two timeouts, within the provider's 5 s budget", async () => {
      useFakeClock();

      const route = vi.fn(never);
      let settled = false;
      const begin = performance.now();
      const pending = checkEmail(
        deps({ "https://api.resend.com/domains": route }, PRODUCTION_TIMING),
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(performance.now() - begin).toBe(PROBE_BUDGET_MS);
      expect(route).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: "error",
        reachable: false,
        transient: true,
        attempts: 2,
        failure_kind: "timeout",
        latency_ms: null,
      });
      expect(result.message).toBe(
        "O Resend não respondeu (2 tentativas de até 3,5 s).",
      );
    });

    it("never reads a body that stalls as 'domain missing', and recovers", async () => {
      useFakeClock();

      const pending = checkEmail(
        deps(
          {
            "https://api.resend.com/domains": sequence(stalledBody, VERIFIED),
          },
          PRODUCTION_TIMING,
        ),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const result = await pending;

      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 2,
        failure_kind: "timeout",
      });
      expect(JSON.stringify(result)).not.toContain("não está na conta");
    });

    it("says the answer was cut when the body stalls twice", async () => {
      useFakeClock();

      const pending = checkEmail(
        deps(
          { "https://api.resend.com/domains": stalledBody },
          PRODUCTION_TIMING,
        ),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const result = await pending;

      expect(result).toMatchObject({
        status: "error",
        reachable: true,
        transient: true,
        failure_kind: "timeout",
      });
      expect(result.message).toContain("começou a responder, mas não terminou");
      expect(result.message).not.toContain("não está na conta");
    });

    it("treats a malformed or incomplete list as a failed attempt, never as 'domain missing'", async () => {
      for (const malformed of [
        () =>
          new Response("<html>502 Bad Gateway</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        () => new Response('{"data":[{"name":"intra', { status: 200 }),
        () => json(200, { object: "list" }),
      ]) {
        const route = vi.fn(malformed);
        const result = await checkEmail(
          deps({ "https://api.resend.com/domains": route }),
        );

        expect(route).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
          status: "error",
          reachable: true,
          transient: true,
          attempts: 2,
          failure_kind: "invalid_response",
        });
        expect(result.message).toContain("respondeu de forma incompleta");
        expect(result.message).not.toContain("não está na conta");
      }
    });

    it("retries a 5xx once: recovered is unstable, twice is an error with the status", async () => {
      const recovered = await checkEmail(
        deps({
          "https://api.resend.com/domains": sequence(
            () => json(503, {}),
            VERIFIED,
          ),
        }),
      );

      expect(recovered).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 2,
        failure_kind: "http_5xx",
      });

      const down = await checkEmail(
        deps({ "https://api.resend.com/domains": () => json(503, {}) }),
      );

      expect(down).toMatchObject({
        status: "error",
        reachable: true,
        transient: true,
        attempts: 2,
        failure_kind: "http_5xx",
      });
      expect(down.details.http_status).toBe(503);
      expect(down.message).toContain("HTTP 503");
    });

    it("does not repeat a rate-limited call: a 429 is a transient warning", async () => {
      const route = vi.fn(() => json(429, { name: "rate_limit_exceeded" }));
      const result = await checkEmail(
        deps({ "https://api.resend.com/domains": route }),
      );

      expect(route).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 1,
        failure_kind: "throttled",
      });
    });

    it("asks once and keeps a definitive answer: refused key, domain missing", async () => {
      for (const answer of [
        () => json(401, { name: "validation_error" }),
        () => json(403, {}),
        () => json(200, { data: [{ name: "outro.com", status: "verified" }] }),
      ]) {
        const route = vi.fn(answer);
        const result = await checkEmail(
          deps({ "https://api.resend.com/domains": route }),
        );

        expect(route).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          status: "error",
          transient: false,
          attempts: 1,
          failure_kind: null,
        });
      }
    });

    it("keeps a definitive refusal an error even when it came on the second attempt", async () => {
      const result = await checkEmail(
        deps({
          "https://api.resend.com/domains": sequence(
            () => {
              throw resetError();
            },
            () => json(401, { name: "validation_error" }),
          ),
        }),
      );

      expect(result).toMatchObject({
        status: "error",
        transient: false,
        attempts: 2,
      });
      expect(result.message).toContain("RESEND_SECRET_KEY");
    });
  });

  describe("storage (R2)", () => {
    function s3Error(status: number) {
      return Object.assign(new Error("UnknownError"), {
        name: "Unknown",
        $metadata: { httpStatusCode: status },
      });
    }

    it("retries a 5xx once: recovered is unstable", async () => {
      let calls = 0;
      const result = await checkStorage(
        deps(HEALTHY, {
          headBucket: async () => {
            calls += 1;

            if (calls === 1) throw s3Error(503);
          },
        }),
      );

      expect(calls).toBe(2);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        attempts: 2,
        failure_kind: "http_5xx",
      });
    });

    it("a 5xx twice is the R2 answering an error, not 'no route'", async () => {
      const result = await checkStorage(
        deps(HEALTHY, {
          headBucket: async () => {
            throw s3Error(503);
          },
        }),
      );

      expect(result).toMatchObject({
        status: "error",
        reachable: true,
        transient: true,
        attempts: 2,
        failure_kind: "http_5xx",
      });
      expect(result.details.http_status).toBe(503);
      expect(result.message).toContain("HTTP 503");
      expect(result.message).not.toContain("Sem rota");
    });

    it("asks once for a refused credential or a missing bucket", async () => {
      for (const status of [401, 403, 404]) {
        const headBucket = vi.fn(async () => {
          throw s3Error(status);
        });
        const result = await checkStorage(deps(HEALTHY, { headBucket }));

        expect(headBucket).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          status: "error",
          reachable: true,
          transient: false,
          attempts: 1,
        });
        expect(result.details.http_status).toBe(status);
      }
    });

    it("names the network code when there is no route, without the host", async () => {
      const result = await checkStorage(
        deps(HEALTHY, {
          headBucket: async () => {
            throw Object.assign(
              new Error("getaddrinfo EAI_AGAIN acc.r2.cloudflarestorage.com"),
              { code: "EAI_AGAIN" },
            );
          },
        }),
      );

      expect(result).toMatchObject({
        status: "error",
        reachable: false,
        transient: true,
        attempts: 2,
        failure_kind: "network",
      });
      expect(result.message).toContain("EAI_AGAIN");
      expect(result.message).not.toContain("cloudflarestorage");
    });

    it("holds its deadline when the SDK ignores the abort, and aborts every attempt", async () => {
      useFakeClock();

      const signals: AbortSignal[] = [];
      const pending = checkStorage(
        deps(HEALTHY, {
          ...PRODUCTION_TIMING,
          headBucket: (signal) => {
            signals.push(signal);

            return new Promise<void>(() => {});
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const result = await pending;

      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(result).toMatchObject({
        status: "error",
        reachable: false,
        failure_kind: "timeout",
        attempts: 2,
      });
      expect(result.message).toBe(
        "O R2 não respondeu (2 tentativas de até 3,5 s).",
      );
    });

    it("reads the SDK's abort (AbortError caused by a TimeoutError) as a timeout", async () => {
      const result = await checkStorage(
        deps(HEALTHY, {
          timeoutMs: 20,
          headBucket: (signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(
                  Object.assign(new Error("Request aborted"), {
                    name: "AbortError",
                    cause: { name: "TimeoutError" },
                  }),
                ),
              );
            }),
        }),
      );

      expect(result).toMatchObject({
        status: "error",
        failure_kind: "timeout",
        attempts: 2,
      });
    });
  });

  /**
   * The token check was one attempt while /health had two: in the DNS blip
   * /health recovered from, the token check had already failed and OCR
   * still read "Com erro". And a 5xx in front of the service read as
   * "token aceito".
   */
  describe("OCR token check", () => {
    const HEALTH = {
      "http://trajetto-ai:8080/health":
        HEALTHY["http://trajetto-ai:8080/health"],
    };

    it("retries a reset once and recovers: unstable, not an error", async () => {
      const route = sequence(
        () => {
          throw resetError();
        },
        () => json(400, { error: "unknown_profile" }),
      );
      const { log, warn } = recordingLog();

      const result = await checkAiOcr(
        deps({ ...HEALTH, "http://trajetto-ai:8080/v1/read": route }, { log }),
      );

      expect(route).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        failure_kind: "network",
        message: "Serviço pronto e token aceito.",
      });
      expect(result.warnings).toContain(
        "A 1ª conferência do token falhou (falha de rede); a 2ª respondeu.",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "ai_ocr",
          kind: "network",
          code: "ECONNRESET",
          will_retry: true,
        }),
        "provider probe attempt failed",
      );
    });

    it("retries a timeout inside the budget and recovers", async () => {
      useFakeClock();

      const route = sequence(never, () => json(400, {}));
      const pending = checkAiOcr(
        deps(
          { ...HEALTH, "http://trajetto-ai:8080/v1/read": route },
          PRODUCTION_TIMING,
        ),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const result = await pending;

      expect(route).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        failure_kind: "timeout",
      });
    });

    it("is an error after two failed attempts, transient, naming the cause", async () => {
      const route = vi.fn(() => {
        throw resetError();
      });

      const result = await checkAiOcr(
        deps({ ...HEALTH, "http://trajetto-ai:8080/v1/read": route }),
      );

      expect(route).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: "error",
        reachable: true,
        transient: true,
        failure_kind: "network",
      });
      expect(result.message).toContain("2 tentativas");
      expect(result.message).toContain("ECONNRESET");
    });

    it("never reads a 5xx as an accepted token: retried, then an error with the status", async () => {
      const recovered = await checkAiOcr(
        deps({
          ...HEALTH,
          "http://trajetto-ai:8080/v1/read": sequence(
            () => json(502, {}),
            () => json(400, {}),
          ),
        }),
      );

      expect(recovered).toMatchObject({
        status: "warning",
        transient: true,
        failure_kind: "http_5xx",
      });

      const down = await checkAiOcr(
        deps({
          ...HEALTH,
          "http://trajetto-ai:8080/v1/read": () => json(502, {}),
        }),
      );

      expect(down).toMatchObject({
        status: "error",
        transient: true,
        failure_kind: "http_5xx",
      });
      expect(down.details.http_status).toBe(502);
      expect(down.message).toContain("HTTP 502");
      expect(down.message).not.toContain("token aceito");
    });

    it("does not repeat a rate-limited check: a 429 is a transient warning", async () => {
      const route = vi.fn(() => json(429, {}));

      const result = await checkAiOcr(
        deps({ ...HEALTH, "http://trajetto-ai:8080/v1/read": route }),
      );

      expect(route).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: "warning",
        transient: true,
        failure_kind: "throttled",
      });
    });

    it("asks once for a refused token, and keeps it an error even after a retry", async () => {
      const once = vi.fn(() => json(401, { error: "unauthorized" }));

      const refused = await checkAiOcr(
        deps({ ...HEALTH, "http://trajetto-ai:8080/v1/read": once }),
      );

      expect(once).toHaveBeenCalledTimes(1);
      expect(refused).toMatchObject({ status: "error", transient: false });
      expect(refused.message).toContain("AI_LOCAL_TOKEN");

      const afterReset = await checkAiOcr(
        deps({
          ...HEALTH,
          "http://trajetto-ai:8080/v1/read": sequence(
            () => {
              throw resetError();
            },
            () => json(401, { error: "unauthorized" }),
          ),
        }),
      );

      expect(afterReset).toMatchObject({ status: "error", transient: false });
      expect(afterReset.message).toContain("AI_LOCAL_TOKEN");
    });
  });

  describe("the whole report", () => {
    it("stays bounded by one provider's budget when every provider hangs", async () => {
      useFakeClock();

      const hang = () => never();
      const begin = performance.now();
      const pending = checkProviders(
        deps(
          {
            "https://api.resend.com": hang,
            "https://graph.facebook.com": hang,
            "https://exp.host": hang,
            "http://trajetto-ai:8080": hang,
          },
          {
            ...PRODUCTION_TIMING,
            headBucket: () => new Promise<void>(() => {}),
          },
        ),
      );

      await vi.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      const report = await pending;

      expect(performance.now() - begin).toBe(PROBE_BUDGET_MS);

      const byKey = Object.fromEntries(report.providers.map((p) => [p.key, p]));

      for (const key of ["email", "whatsapp", "push", "storage", "ai_ocr"]) {
        expect(byKey[key]).toMatchObject({ status: "error", transient: true });
      }
      // Nothing probed, nothing transient.
      expect(byKey.proof_certificate).toMatchObject({
        attempts: 0,
        transient: false,
        failure_kind: null,
      });
    });

    it("only reads: no send, at most two calls per provider URL", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });

        return json(500, {});
      }) as typeof fetch;
      let heads = 0;

      await checkProviders(
        deps(
          {},
          {
            fetch: failing,
            headBucket: async () => {
              heads += 1;
              throw Object.assign(new Error("x"), {
                $metadata: { httpStatusCode: 500 },
              });
            },
          },
        ),
      );

      const perUrl = new Map<string, number>();

      for (const call of calls) {
        perUrl.set(call.url, (perUrl.get(call.url) ?? 0) + 1);

        if (call.method !== "GET") {
          // The receipts query for a nil id and the OCR token check refused
          // with 400/401: neither sends anything.
          expect(
            call.url.endsWith("/push/getReceipts") ||
              call.url.includes("/v1/read?profile=readiness-probe"),
          ).toBe(true);
        }
      }

      expect(Math.max(...perUrl.values())).toBeLessThanOrEqual(2);
      expect(heads).toBe(2);
    });

    it("never logs a credential, a URL or a host", async () => {
      const { log, warn } = recordingLog();

      await checkProviders(
        deps(
          {},
          {
            log,
            headBucket: async () => {
              throw Object.assign(
                new Error("getaddrinfo ENOTFOUND acc.r2.cloudflarestorage.com"),
                { code: "ENOTFOUND", hostname: "acc.r2.cloudflarestorage.com" },
              );
            },
          },
        ),
      );

      expect(warn).toHaveBeenCalled();

      const logged = JSON.stringify(warn.mock.calls);

      for (const secret of Object.values(SECRETS))
        expect(logged).not.toContain(secret);
      expect(logged).not.toContain("cloudflarestorage");
      expect(logged).not.toContain("://");
      expect(logged).not.toContain("trajetto-ai");
    });
  });

  describe("how long a report is served", () => {
    function report(transient: boolean): ProviderReadinessReport {
      return {
        checked_at: "2026-10-07T12:00:00.000Z",
        providers: [
          {
            key: "email",
            label: "E-mail (Resend)",
            status: transient ? "error" : "ok",
            configured: true,
            reachable: !transient,
            latency_ms: transient ? null : 120,
            missing_env: [],
            message: "",
            warnings: [],
            details: {},
            attempts: transient ? 2 : 1,
            transient,
            failure_kind: transient ? "timeout" : null,
          },
        ],
      };
    }

    it("is 5 s when some provider is transient, 30 s otherwise", () => {
      expect(readinessTtl(report(true))).toBe(READINESS_TRANSIENT_CACHE_MS);
      expect(readinessTtl(report(false))).toBe(READINESS_CACHE_MS);

      // A copy from a replica that predates the field reads as clean.
      const older = report(false) as {
        providers: Array<Partial<ProviderReadinessReport["providers"][0]>>;
      };

      delete older.providers[0].transient;
      expect(readinessTtl(older as ProviderReadinessReport)).toBe(
        READINESS_CACHE_MS,
      );
    });

    it("probes again after 5 s when the last round caught a blip, then keeps the clean one 30 s", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });

      let resendDown = true;
      const routes: Record<string, Route> = {
        ...HEALTHY,
        "https://api.resend.com/domains": () =>
          resendDown ? json(503, {}) : VERIFIED(),
      };
      const cache = readinessCache(() => deps(routes), null);
      const email = (value: ProviderReadinessReport) =>
        value.providers.find((p) => p.key === "email");

      const first = await cache.read();

      expect(first.cached).toBe(false);
      expect(email(first.value)).toMatchObject({
        status: "error",
        transient: true,
      });

      resendDown = false;

      vi.advanceTimersByTime(READINESS_TRANSIENT_CACHE_MS - 1);
      const stillCached = await cache.read();

      expect(stillCached.cached).toBe(true);
      expect(email(stillCached.value)?.status).toBe("error");

      vi.advanceTimersByTime(1);
      const recovered = await cache.read();

      expect(recovered.cached).toBe(false);
      expect(email(recovered.value)).toMatchObject({
        status: "ok",
        transient: false,
      });

      vi.advanceTimersByTime(READINESS_CACHE_MS - 1);
      expect((await cache.read()).cached).toBe(true);
    });
  });
});
