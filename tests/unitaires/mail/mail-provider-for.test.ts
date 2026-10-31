import { describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EtherealMailProvider } from "@/shared/providers/mail-provider/implementations/ethereal-mail-provider";
import { ResendMailProvider } from "@/shared/providers/mail-provider/implementations/resend-mail-provider";
import {
  TEST_INBOX_LIMIT,
  TestInboxMailProvider,
} from "@/shared/providers/mail-provider/implementations/test-inbox-mail-provider";
import { mailProviderFor } from "@/shared/providers/mail-provider/mail-provider-for";

/**
 * Which transport an e-mail leaves through, per NODE_ENV.
 *
 * The E2E suite and the web's browser suites run the API with NODE_ENV=test,
 * and every message went through Ethereal — an account created at
 * api.nodemailer.com and an SMTP session with smtp.ethereal.email, on every
 * run: a pipeline that failed when a third party did (CI audit, decision D7).
 * The test inbox keeps them in the process instead. The other half of the
 * decision is the one that matters in production: the inbox exists under
 * NODE_ENV=test and nowhere else, or a stack could lose every e-mail in
 * silence.
 */
describe("the mail transport for each NODE_ENV", () => {
  it("is Resend in production", () => {
    expect(mailProviderFor("production")).toBe(ResendMailProvider);
  });

  it("is Ethereal in development, where its preview link is the point", () => {
    expect(mailProviderFor("development")).toBe(EtherealMailProvider);
  });

  it("is the in-process test inbox under NODE_ENV=test, and under nothing else", () => {
    expect(mailProviderFor("test")).toBe(TestInboxMailProvider);

    const others = ["production", "development", "staging", "", "TEST"];

    for (const nodeEnv of others) {
      expect(mailProviderFor(nodeEnv), nodeEnv).not.toBe(TestInboxMailProvider);
    }
  });
});

describe("the test inbox", () => {
  function template(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), "test-inbox-"));
    const path = join(directory, "message.hbs");

    writeFileSync(path, body);

    return path;
  }

  it("refuses to exist outside NODE_ENV=test", () => {
    for (const nodeEnv of ["production", "development"]) {
      expect(() => new TestInboxMailProvider(nodeEnv), nodeEnv).toThrow(
        /only exists with NODE_ENV=test/,
      );
    }
  });

  // `env.NODE_ENV` comes from the container's environment at run time, so a
  // NODE_ENV=test set on a deployed Application would pass the check above.
  // The second check is the build's NODE_ENV: "production" in the image,
  // whatever the container says.
  it("refuses to exist in a build made for production, even with NODE_ENV=test at run time", () => {
    for (const builtFor of ["production", "development", ""]) {
      expect(
        () => new TestInboxMailProvider("test", builtFor),
        builtFor,
      ).toThrow(/only exists with NODE_ENV=test/);
    }

    expect(() => new TestInboxMailProvider("test", "test")).not.toThrow();
  });

  it("reads the build's NODE_ENV from the expression tsup replaces in the image", () => {
    const source = (path: string) =>
      readFileSync(resolve(process.cwd(), path), "utf8");

    // tsup writes the build's NODE_ENV (production unless told otherwise)
    // over every `process.env.NODE_ENV` in the bundle…
    expect(source("tsup.config.ts")).toMatch(
      /"process\.env\.NODE_ENV":\s*JSON\.stringify\(\s*process\.env\.NODE_ENV \|\| "production",?\s*\)/,
    );
    // …and the Dockerfile's builder stage leaves it unset, so that is
    // "production".
    const builder = /FROM node AS builder\n([\s\S]*?)\nFROM /.exec(
      source("Dockerfile").replace(/\r\n/g, "\n"),
    )?.[1];

    expect(builder).toBeDefined();
    expect(builder).not.toMatch(/NODE_ENV/);
    // The provider's default is that very expression, written out.
    expect(
      source(
        "src/shared/providers/mail-provider/implementations/test-inbox-mail-provider.ts",
      ),
    ).toMatch(/builtFor: string \| undefined = process\.env\.NODE_ENV,/);
  });

  it("renders the template, keeps the message, and answers the identity the pipeline relies on", async () => {
    const inbox = new TestInboxMailProvider("test");

    const sent = await inbox.sendMail({
      to: "pessoa@exemplo.com.br",
      subject: "Conta a pagar",
      path: template("<p>Olá, {{name}}</p>"),
      variables: { name: "Maria" },
      referenceId: "018fc000-0000-7000-8000-0000000000aa",
    });

    expect(sent.messageId).toBe(
      "<018fc000-0000-7000-8000-0000000000aa@intrajetto.com>",
    );
    expect(inbox.messages()).toEqual([
      expect.objectContaining({
        to: "pessoa@exemplo.com.br",
        subject: "Conta a pagar",
        html: "<p>Olá, Maria</p>",
        messageId: sent.messageId,
      }),
    ]);
  });

  it("fails on a template that cannot be read, as the real providers do", async () => {
    const inbox = new TestInboxMailProvider("test");

    await expect(
      inbox.sendMail({
        to: "pessoa@exemplo.com.br",
        subject: "Sem modelo",
        path: join(tmpdir(), "nao-existe", "modelo.hbs"),
        variables: {},
      }),
    ).rejects.toThrow();
    expect(inbox.messages()).toEqual([]);
  });

  it("keeps only the newest messages, so a long suite does not grow it forever", async () => {
    const inbox = new TestInboxMailProvider("test");
    const path = template("{{n}}");

    for (let n = 0; n < TEST_INBOX_LIMIT + 5; n += 1) {
      await inbox.sendMail({
        to: "pessoa@exemplo.com.br",
        subject: "Muitas",
        path,
        variables: { n },
      });
    }

    expect(inbox.messages()).toHaveLength(TEST_INBOX_LIMIT);
    expect(inbox.messages()[0].html).toBe("5");
  });
});
