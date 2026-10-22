import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    LOG_LEVEL: "info",
    RESEND_SECRET_KEY: "re_test",
    RESEND_FROM_EMAIL: "Trajetto <nao-responda@trajetto.com.br>",
  },
}));

// The provider logs through the shared logger (OBS-14): the line is checked as
// the JSON pino actually writes, `err` serializer included.
vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import { ResendMailProvider } from "@/shared/providers/mail-provider/implementations/resend-mail-provider";
import { toMailDeliveryError } from "@/shared/providers/mail-provider/errors/mail-delivery-error";
import { maskEmail, redactEmails } from "@/shared/logging/redact-email";

import { clearLogged, logged } from "../../support/log-capture";

/**
 * A failed e-mail must not write the recipient's address anywhere.
 *
 * The provider built its error as "Falha ao enviar e-mail para <to>", and an
 * SMTP 5xx echoes the recipient in its own text on top of that. The message
 * went to stdout from the provider, into notification_delivery.lastError for
 * 30 to 90 days, and out of /health/dead-letter — the address of a carrier's
 * customer, who never agreed to any of it (LGPD: data minimisation).
 */
const RECIPIENT = "ana.cliente@exemplo.com.br";

function smtpRejection(): Error {
  return Object.assign(
    new Error(`550 5.1.1 <${RECIPIENT}>: Recipient address rejected`),
    {
      responseCode: 550,
      code: "EENVELOPE",
      response: `550 5.1.1 <${RECIPIENT}>`,
    },
  );
}

const template = resolve(
  process.cwd(),
  "src",
  "modules",
  "notification",
  "views",
  "notification.hbs",
);

const variables = {
  name: "Pessoa",
  year: 2026,
  title: "Título",
  message: "Mensagem",
  link: "https://app.trajetto.com.br/notifications",
  logo: "https://example.com/logo.png",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactEmails", () => {
  it("keeps the first letter and the domain, and nothing else of the mailbox", () => {
    expect(maskEmail("ana@b.com")).toBe("a***@b.com");
    expect(redactEmails(`rejected <${RECIPIENT}>, cc x@y.org`)).toBe(
      "rejected <a***@exemplo.com.br>, cc x***@y.org",
    );
  });

  it("leaves text without an address alone", () => {
    expect(redactEmails("421 4.7.0 Try again later")).toBe(
      "421 4.7.0 Try again later",
    );
  });
});

describe("toMailDeliveryError", () => {
  it("never carries the recipient in the message the pipeline stores", () => {
    const error = toMailDeliveryError(
      smtpRejection(),
      "Falha ao enviar e-mail",
    );

    expect(error.message).not.toContain(RECIPIENT);
    expect(error.message).toContain("a***@exemplo.com.br");

    // The classification is untouched: a 5xx is still permanent.
    expect(error.retryable).toBe(false);
    expect(error.responseCode).toBe(550);
  });

  it("nor in the cause a logger would print after it", () => {
    // pino's err serializer and console.error both walk `cause`.
    const error = toMailDeliveryError(
      smtpRejection(),
      "Falha ao enviar e-mail",
    );

    expect(JSON.stringify(error.cause ?? null)).not.toContain(RECIPIENT);
    expect(
      String((error.cause as Error | undefined)?.message ?? ""),
    ).not.toContain(RECIPIENT);
  });
});

describe("ResendMailProvider on a refused recipient", () => {
  it("throws and logs without the address", async () => {
    clearLogged();

    const provider = new ResendMailProvider();

    (provider as unknown as { client: unknown }).client = {
      sendMail: async () => {
        throw smtpRejection();
      },
    };

    const thrown = await provider
      .sendMail({
        to: RECIPIENT,
        subject: "Assunto",
        path: template,
        referenceId: "delivery-1",
        variables,
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(thrown).not.toBeNull();
    expect(thrown?.message).not.toContain(RECIPIENT);

    // Logged, with what an operator acts on, and without the address.
    expect(logged("error")).toHaveLength(1);
    expect(logged("error")[0]).toMatchObject({ retryable: false });
    expect(JSON.stringify(logged())).not.toContain(RECIPIENT);
  });
});
