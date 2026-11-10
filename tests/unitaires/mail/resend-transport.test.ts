import { createServer, type AddressInfo, type Server } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import nodemailer from "nodemailer";

vi.mock("@/env", () => ({
  env: {
    // The provider logs through the shared logger, which reads its level.
    LOG_LEVEL: "silent",
    RESEND_SECRET_KEY: "re_test",
    RESEND_FROM_EMAIL: "Trajetto <nao-responda@trajetto.com.br>",
  },
}));

import {
  ResendMailProvider,
  buildResendMessage,
  resendTransportOptions,
} from "@/shared/providers/mail-provider/implementations/resend-mail-provider";
import {
  MailDeliveryError,
  toMailDeliveryError,
} from "@/shared/providers/mail-provider/errors/mail-delivery-error";

/**
 * What the Resend transport does on the wire, with the nodemailer it ships.
 *
 * nodemailer 10.0.0 to 10.0.11 ignored `requireTLS` (fixed in 10.0.12): on
 * a server that did not offer STARTTLS they sent AUTH, with the API key, in
 * plain text. Reading the option back proves nothing about that, so this
 * talks to a local SMTP server that never upgrades and checks what it was
 * sent. The headers the idempotency rests on are read from the raw message,
 * as a receiver sees them, not from the object handed to the transport.
 */

/** A plain-text SMTP server: no STARTTLS, AUTH and the rest accepted. */
function plainTextSmtp(): Promise<{
  server: Server;
  port: number;
  commands: string[];
}> {
  const commands: string[] = [];

  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;

    socket.write("220 trajetto.test ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");

        if (end === -1) return;

        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write("250 2.0.0 queued\r\n");
      }

      let newline = buffer.indexOf("\r\n");

      while (newline !== -1 && !inData) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        const verb = line.split(" ")[0].toUpperCase();
        commands.push(verb);

        if (verb === "EHLO") {
          // AUTH offered, STARTTLS not: what a downgraded path looks like.
          socket.write("250-trajetto.test\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (verb === "STARTTLS") {
          socket.write("502 5.5.1 STARTTLS not available\r\n");
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 2.0.0 Bye\r\n");
        } else {
          socket.write("250 2.0.0 OK\r\n");
        }

        newline = buffer.indexOf("\r\n");
      }
    });

    socket.on("error", () => undefined);
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({ server, port, commands });
    });
  });
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

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The production options, pointed at the local server. */
function localTransport(port: number, overrides: object = {}) {
  const transport = nodemailer.createTransport({
    ...resendTransportOptions(),
    host: "127.0.0.1",
    port,
    ...overrides,
  });

  cleanups.push(() => transport.close());

  return transport;
}

describe("a server that does not offer STARTTLS", () => {
  it("never receives AUTH nor the message: the send fails instead", async () => {
    const { server, port, commands } = await plainTextSmtp();
    cleanups.push(() => server.close());

    const provider = new ResendMailProvider();
    (provider as unknown as { client: unknown }).client = localTransport(port);

    const thrown = await provider
      .sendMail({
        to: "pessoa@exemplo.com.br",
        subject: "Assunto",
        path: template,
        referenceId: "delivery-123",
        variables,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(MailDeliveryError);
    expect((thrown as MailDeliveryError).code).toBe("ETLS");

    // Asked to upgrade, refused, and nothing after it: no key, no body.
    expect(commands).toContain("STARTTLS");
    expect(commands).not.toContain("AUTH");
    expect(commands).not.toContain("MAIL");
    expect(commands).not.toContain("DATA");
  });

  it("does receive AUTH in plain text without requireTLS (the harness sees it)", async () => {
    // The control: the server above would have caught the key, so the
    // assertion that it did not is not vacuous.
    const { server, port, commands } = await plainTextSmtp();
    cleanups.push(() => server.close());

    await localTransport(port, { requireTLS: false }).sendMail(
      buildResendMessage({
        to: "pessoa@exemplo.com.br",
        subject: "Assunto",
        html: "<p>Mensagem</p>",
      }),
    );

    expect(commands).toContain("AUTH");
    expect(commands).toContain("DATA");
  });
});

describe("a stack without RESEND_SECRET_KEY", () => {
  it.each([true, false])(
    "fails as EAUTH 'Missing credentials', not retried, and never sends AUTH (pool: %s)",
    async (pool) => {
      // What the staging logs show for an empty key: EAUTH, not ENOAUTH
      // (that one needs a transport with no auth object under forceAuth).
      const { server, port, commands } = await plainTextSmtp();
      cleanups.push(() => server.close());

      const provider = new ResendMailProvider();
      (provider as unknown as { client: unknown }).client = localTransport(
        port,
        { requireTLS: false, pool, auth: { user: "resend", pass: undefined } },
      );

      const thrown = await provider
        .sendMail({
          to: "pessoa@exemplo.com.br",
          subject: "Assunto",
          path: template,
          referenceId: "delivery-123",
          variables,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(MailDeliveryError);
      expect(thrown).toMatchObject({ code: "EAUTH", retryable: false });
      expect((thrown as MailDeliveryError).message).toContain(
        'Missing credentials for "PLAIN"',
      );
      expect(commands).not.toContain("AUTH");
      expect(commands).not.toContain("DATA");
    },
  );
});

describe("the raw message", () => {
  async function raw(referenceId?: string): Promise<string> {
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    });

    const info = await transport.sendMail(
      buildResendMessage({
        to: "pessoa@exemplo.com.br",
        subject: "Assunto",
        html: "<p>Mensagem</p>",
        referenceId,
      }),
    );

    return (info.message as Buffer).toString("utf8");
  }

  it("carries the deterministic Message-ID and both reference headers", async () => {
    const message = await raw("delivery-123");

    expect(message).toMatch(
      /^Message-ID: <delivery-123@trajetto\.com\.br>\r?$/im,
    );
    expect(message).toMatch(/^Resend-Idempotency-Key: delivery-123\r?$/im);
    expect(message).toMatch(/^X-Entity-Ref-ID: delivery-123\r?$/im);
    expect(message).toMatch(
      /^From: Trajetto <nao-responda@trajetto\.com\.br>\r?$/im,
    );
  });

  it("carries neither reference header when there is no delivery behind it", async () => {
    const message = await raw();

    expect(message).not.toMatch(/^Resend-Idempotency-Key:/im);
    expect(message).not.toMatch(/^X-Entity-Ref-ID:/im);
    expect(message).not.toMatch(/^Message-ID: <delivery-/im);
  });
});

describe("the transport options", () => {
  it("never let message content name a file or a URL", async () => {
    expect(resendTransportOptions()).toMatchObject({
      requireTLS: true,
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      disableFileAccess: resendTransportOptions().disableFileAccess,
      disableUrlAccess: resendTransportOptions().disableUrlAccess,
    });

    const attempt = (attachment: { path: string }) =>
      transport
        .sendMail({
          ...buildResendMessage({
            to: "pessoa@exemplo.com.br",
            subject: "Assunto",
            html: "<p>Mensagem</p>",
          }),
          attachments: [attachment],
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

    const fileRefusal = await attempt({
      path: resolve(process.cwd(), "package.json"),
    });
    const urlRefusal = await attempt({ path: "https://example.com/x.pdf" });

    expect(fileRefusal).toMatchObject({ code: "EFILEACCESS" });
    expect(urlRefusal).toMatchObject({ code: "EURLACCESS" });

    // The same refusal on every attempt: it fails now instead of spending
    // the pipeline's retries.
    for (const refusal of [fileRefusal, urlRefusal]) {
      expect(toMailDeliveryError(refusal, "Falha").retryable).toBe(false);
    }
  });
});
