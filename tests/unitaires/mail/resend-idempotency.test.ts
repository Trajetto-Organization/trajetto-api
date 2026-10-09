import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    // The provider logs through the shared logger, which reads its level.
    LOG_LEVEL: "silent",
    RESEND_SECRET_KEY: "re_test",
    RESEND_FROM_EMAIL: "Trajetto <nao-responda@trajetto.com.br>",
  },
}));

import { ResendMailProvider } from "@/shared/providers/mail-provider/implementations/resend-mail-provider";

/**
 * The only duplicate e-mail a provider can prevent for us.
 *
 * A notification e-mail is retried when the worker cannot tell whether it was
 * sent — a crash after the send, an answer lost to a timeout, a wait the
 * pipeline gave up on. Resend drops a second message carrying the same
 * idempotency key within 24 hours; before, nothing carried one, and each of
 * those retries reached the inbox again.
 */
const template = resolve(
  process.cwd(),
  "src",
  "modules",
  "notification",
  "views",
  "notification.hbs",
);

function providerCapturing(sent: Array<Record<string, unknown>>) {
  const provider = new ResendMailProvider();

  (provider as unknown as { client: unknown }).client = {
    sendMail: async (message: Record<string, unknown>) => {
      sent.push(message);
      return { messageId: "<id@trajetto.com.br>" };
    },
  };

  return provider;
}

const variables = {
  name: "Pessoa",
  year: 2026,
  title: "Título",
  message: "Mensagem",
  link: "https://app.trajetto.com.br/notifications",
  logo: "https://example.com/logo.png",
};

describe("ResendMailProvider", () => {
  it("sends the delivery id as Resend's idempotency key", async () => {
    const sent: Array<Record<string, unknown>> = [];

    await providerCapturing(sent).sendMail({
      to: "pessoa@exemplo.com.br",
      subject: "Assunto",
      path: template,
      referenceId: "delivery-123",
      variables,
    });

    const headers = sent[0].headers as Record<string, string>;

    expect(headers["Resend-Idempotency-Key"]).toBe("delivery-123");
  });

  it("sends none when there is no delivery behind the message", async () => {
    const sent: Array<Record<string, unknown>> = [];

    await providerCapturing(sent).sendMail({
      to: "pessoa@exemplo.com.br",
      subject: "Assunto",
      path: template,
      variables,
    });

    const headers = sent[0].headers as Record<string, string>;

    // A constant key would make Resend drop every message after the first.
    expect(headers["Resend-Idempotency-Key"]).toBeUndefined();
  });
});

describe("the SMTP connection", () => {
  it("refuses to authenticate or send unless STARTTLS succeeds", () => {
    // On 587 nodemailer upgrades only if the server offers STARTTLS; anyone on
    // the path can remove the offer and read the API key in AUTH.
    const provider = new ResendMailProvider();

    const options = (provider as unknown as {
      client: { options: { requireTLS?: boolean; secure?: boolean } };
    }).client.options;

    expect(options.requireTLS || options.secure).toBe(true);
  });
});
