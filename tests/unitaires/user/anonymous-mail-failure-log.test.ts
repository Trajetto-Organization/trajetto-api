import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the anonymous mail routes write to the logs when the provider fails.
 *
 * "Forgot my password" and "resend my 2FA code" now send after answering, and
 * a failure is logged instead of answered (GAP3-11). The error the provider
 * raises is a MailDeliveryError whose message names the recipient ("Falha ao
 * enviar e-mail para <address>") and whose `cause` is the SMTP reply, which
 * often quotes the address again. Both routes are anonymous: logging that
 * error whole writes whatever address anybody typed into log storage (LGPD).
 * The line keeps what an operator acts on — code, SMTP reply, retryable —
 * and never the address.
 */
const RECIPIENT = "pessoa.cadastrada@exemplo.com.br";

vi.mock("@/shared/services/transactional-mail-service", async () => {
  const { toMailDeliveryError } = await import(
    "@/shared/providers/mail-provider/errors/mail-delivery-error"
  );

  return {
    // What ResendMailProvider throws when the SMTP server refuses.
    sendTransactionalMail: async ({ email }: { email: string }) => {
      const smtp = Object.assign(
        new Error(`550 5.1.1 <${email}>: Recipient address rejected`),
        { code: "EENVELOPE", responseCode: 550 },
      );

      throw toMailDeliveryError(smtp, `Falha ao enviar e-mail para ${email}`);
    },
  };
});

// The use cases log through the shared logger (OBS-14): what is checked is
// the JSON pino writes, with its `err` serializer walking message, stack and
// cause.
vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";
import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";

import { clearLogged, logged } from "../../support/log-capture";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;

/** Every error line, serialized the way a log shipper receives it. */
function loggedText() {
  return logged("error")
    .map((line) => JSON.stringify(line))
    .join("\n");
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  clearLogged();

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  const user = await users.createUser({
    name: "Pessoa Cadastrada",
    email: RECIPIENT,
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
  } as never);

  users.user.find((row) => row.id === user.id)!.two_factor_enabled = true;
});

describe("a provider failure after the answer", () => {
  it("on forgot-password is logged with the SMTP reply, not the address", async () => {
    await new SendForgotPasswordMailUseCase(users, tokens).execute(RECIPIENT);
    await settle();

    const text = loggedText();

    expect(logged("error")).toHaveLength(1);
    expect(text).toContain("550");
    expect(text.toLowerCase()).not.toContain(RECIPIENT);
  });

  it("on the 2FA resend is logged with the SMTP reply, not the address", async () => {
    await new ResendTwoFactorCodeUseCase(users, tokens).execute(RECIPIENT);
    await settle();

    const text = loggedText();

    expect(logged("error")).toHaveLength(1);
    expect(text).toContain("550");
    expect(text.toLowerCase()).not.toContain(RECIPIENT);
  });
});
