// First, as in http.ts: this file is a process entry point of its own.
import "reflect-metadata";

import { container } from "tsyringe";

/**
 * One API replica running the workers, as a process of its own
 * (resilience package, contract §10/§11).
 *
 * The pipelines are module singletons with timers, leases and in-memory
 * guards; "three replicas" is three processes or it is not the property
 * production depends on. A replica here is the real app (`@/http`, the
 * container registrations, the real pipeline services and their real claim
 * SQL) with only the far end of each provider moved to the test's
 * FakeProvider (FAKE_PROVIDER_URL):
 *
 *  - WhatsApp and push run the REAL MetaCloudApiProvider and Expo client;
 *    their `fetch` to graph.facebook.com / exp.host is rewritten to the fake;
 *  - webhooks run the real dispatcher, posting to the fake receiver
 *    (loopback, so the SSRF verifier is the only thing swapped, as in
 *    queue-claim-concurrency.test.ts);
 *  - the AI pipeline runs the real LocalOcrReader against the fake OCR
 *    service, with the photo bytes faked (no bucket here);
 *  - e-mail goes through a forwarding provider that sends what
 *    ResendMailProvider sends as identity: `Resend-Idempotency-Key` = the
 *    delivery id (that mapping is unit-tested in resend-idempotency.test.ts);
 *    SMTP with STARTTLS to a fixed host has no seam worth faking.
 *
 * Env: FAKE_PROVIDER_URL, REPLICA_WORKERS (comma list of notifications,
 * webhooks, ai), REPLICA_HTTP_PORT (optional: also serve HTTP), plus the
 * usual DATABASE_URL / REDIS_URL. stdin line "stop" shuts down gracefully;
 * a SIGKILL from the parent is the crash.
 */
const FAKE = process.env.FAKE_PROVIDER_URL ?? "";
const WORKERS = new Set(
  (process.env.REPLICA_WORKERS ?? "notifications")
    .split(",")
    .map((w) => w.trim()),
);

const REWRITTEN_HOSTS = ["https://graph.facebook.com", "https://exp.host"];

const realFetch = globalThis.fetch;

/**
 * Every call that reaches the fake provider says which replica made it, so
 * a multi-replica test can prove the work was really shared (case F) and not
 * drained by whichever process booted first.
 */
const REPLICA_HEADER = "x-replica-pid";

function tagged(init?: RequestInit): RequestInit {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());

  return {
    ...init,
    headers: { ...headers, [REPLICA_HEADER]: String(process.pid) },
  };
}

globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const host = REWRITTEN_HOSTS.find((prefix) => url.startsWith(prefix));

  if (host) return realFetch(`${FAKE}${url.slice(host.length)}`, tagged(init));
  if (FAKE && url.startsWith(FAKE)) return realFetch(input, tagged(init));

  return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
  const { app } = await import("@/http");
  const { MailDeliveryError } = await import(
    "@/shared/providers/mail-provider/errors/mail-delivery-error"
  );

  await app.ready();

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: {
      to: string;
      subject: string;
      referenceId?: string;
    }) => {
      let response: Response;

      try {
        response = await realFetch(`${FAKE}/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [REPLICA_HEADER]: String(process.pid),
            ...(message.referenceId
              ? { "Resend-Idempotency-Key": message.referenceId }
              : {}),
          },
          body: JSON.stringify({
            to: message.to,
            subject: message.subject,
            referenceId: message.referenceId ?? null,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new MailDeliveryError("Falha ao enviar e-mail", {
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw new MailDeliveryError(
          `Falha ao enviar e-mail (${response.status})`,
          {
            retryable: response.status >= 500,
            responseCode: response.status,
          },
        );
      }

      const { messageId } = (await response.json()) as { messageId: string };

      return { messageId };
    },
  });

  const stops: Array<() => Promise<void>> = [];

  if (WORKERS.has("notifications")) {
    const { NotificationPipelineService } = await import(
      "@/shared/notifications/notification-pipeline-service"
    );
    const pipeline = NotificationPipelineService.getInstance();

    await pipeline.initialize();
    pipeline.wake();
    stops.push(() => pipeline.shutdown());
  }

  if (WORKERS.has("webhooks")) {
    const { WebhookDispatchService } = await import(
      "@/shared/integration/webhook-dispatch-service"
    );

    // The receiver is on loopback, which the production verifier refuses —
    // rightly. The claim, the send and the settling writes are the real ones.
    const { fetch: undiciFetch } = await import("undici");
    const dispatcher = new WebhookDispatchService(
      async () => ({ allowed: true }),
      {
        fetchImpl: ((url: string, init: Parameters<typeof undiciFetch>[1]) =>
          undiciFetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(
                new Headers(init?.headers as HeadersInit).entries(),
              ),
              [REPLICA_HEADER]: String(process.pid),
            },
          })) as typeof undiciFetch,
      },
    );

    await dispatcher.initialize();

    // The production sweep is 5 s; a test cannot wait for many of those.
    const sweep = setInterval(() => {
      dispatcher.processBatch().catch(() => undefined);
    }, 300);

    stops.push(async () => {
      clearInterval(sweep);
      await dispatcher.shutdown();
    });
  }

  if (WORKERS.has("ai")) {
    const [
      { AIAnalysisPipelineService },
      { AIAnalysisProvider },
      { LocalOcrReader },
      { fakeImageLoader },
    ] = await Promise.all([
      import("@/shared/ai/ai-analysis-pipeline-service"),
      import("@/shared/ai/ai-provider"),
      import("@/shared/ai/local/local-ocr-reader"),
      import("@/shared/ai/testing/fake-image-reader"),
    ]);

    const pipeline = AIAnalysisPipelineService.getInstance();

    (pipeline as unknown as { provider: unknown }).provider =
      new AIAnalysisProvider(
        new LocalOcrReader({
          url: FAKE,
          token: "t".repeat(40),
          timeoutMs: Number(process.env.REPLICA_AI_TIMEOUT_MS ?? 20_000),
          maxConcurrency: 2,
        }),
        fakeImageLoader,
      );

    await pipeline.initialize();
    pipeline.wake();
    stops.push(() => pipeline.shutdown());
  }

  const httpPort = Number(process.env.REPLICA_HTTP_PORT ?? 0);

  if (httpPort > 0) {
    await app.listen({ port: httpPort, host: "127.0.0.1" });
  }

  process.stdout.write(`READY ${process.pid}\n`);

  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;

    await Promise.allSettled(stops.map((run) => run()));
    await app.close().catch(() => undefined);

    process.stdout.write("STOPPED\n");
    process.exit(0);
  };

  let pending = "";

  process.stdin.on("data", (chunk) => {
    pending += String(chunk);

    if (pending.includes("stop")) void stop();
  });

  process.stdin.on("end", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error) => {
  process.stderr.write(
    `replica failed to boot: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
