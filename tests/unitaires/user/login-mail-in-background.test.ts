import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";

/**
 * The e-mails a request triggers are dispatched, never awaited.
 *
 * The login of an unverified account and of one with two-factor on, the
 * password-changed notice and the deletion codes all waited on the SMTP
 * round trip to Resend (10 s timeouts): a slow provider held the request past
 * the edge's 100 s patience on a bad day and, on any day, added seconds to a
 * login; a failing one answered 500 after a right password. The secret is
 * stored before the answer, and every flow has a way to ask again (logging
 * in again, "reenviar código", requesting the deletion again), so the mail
 * goes out after the answer and a failure is logged with the account's id.
 *
 * The provider here never settles until the test lets it: a use case that
 * still awaited it would never resolve.
 */
const mail = vi.hoisted(() => {
  const sent: Array<{ templateName: string; token?: string; code?: string }> =
    [];
  let release: (outcome?: Error) => void = () => {};

  return {
    sent,
    pending: () =>
      new Promise<void>((resolve, reject) => {
        release = (outcome) => (outcome ? reject(outcome) : resolve());
      }),
    release: (outcome?: Error) => release(outcome),
  };
});

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: ({
    templateName,
    additionalVariablesProperties,
  }: {
    templateName: string;
    additionalVariablesProperties?: { token?: string; code?: string };
  }) => {
    mail.sent.push({
      templateName,
      token: additionalVariablesProperties?.token,
      code: additionalVariablesProperties?.code,
    });

    return mail.pending();
  },
}));

const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/shared/logging/logger", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/logging/logger")>();

  const child = () => ({
    error: (fields: Record<string, unknown>, message: string) =>
      logged.push({ ...fields, message }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    child,
  });

  return { ...original, logger: { ...original.logger, child } };
});

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { UpdateUserPasswordUseCase } from "@/modules/user/usecases/update-user-password/update-user-password-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

vi.mock("@/websocket", () => ({ sendSecurityEventToUser: vi.fn() }));

const EMAIL = "gestora@exemplo.com.br";
const PASSWORD = "senha-correta";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let login: AuthenticateUserUseCase;

async function account({
  twoFactor = false,
  verified = true,
}: { twoFactor?: boolean; verified?: boolean } = {}) {
  users.user.push({
    id: "user-1",
    name: "Gestora da Frota",
    email: EMAIL,
    password: await hash(PASSWORD, 4),
    role: "MASTER",
    businessId: null,
    session_version: 0,
    two_factor_enabled: twoFactor,
    email_verified: verified ? new Date() : null,
    access_revoked: false,
  } as never);
}

/** Lets the dispatched promise's catch run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mail.sent.length = 0;
  logged.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  login = new AuthenticateUserUseCase(
    users as never,
    tokens as never,
    new InMemoryDriverRepository() as never,
  );
});

describe("the login of an unverified account", () => {
  it("answers with the link stored and dispatched, without waiting for SMTP", async () => {
    await account({ verified: false });

    const result = await login.execute({ email: EMAIL, password: PASSWORD });

    expect(result).toMatchObject({ emailVerification: true });
    expect(mail.sent.map((sent) => sent.templateName)).toEqual([
      "email-verification.hbs",
    ]);
    expect(await tokens.findEmailVerificationTokenByEmail(EMAIL)).toBeTruthy();

    // A provider failure after the answer is logged with the account, and
    // never with the address or the link.
    mail.release(new Error("smtp 421: try again later"));
    await settle();

    expect(logged).toEqual([
      expect.objectContaining({
        userId: "user-1",
        message: "e-mail verification link could not be sent",
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(EMAIL);
  });
});

describe("the login of an account with two-factor on", () => {
  it("answers with the challenge while the code is still on its way", async () => {
    await account({ twoFactor: true });

    const result = await login.execute({ email: EMAIL, password: PASSWORD });

    expect(result).toMatchObject({ isTwoFactorVerification: true });
    expect(result.twoFactorChallenge).toBeTruthy();
    expect(mail.sent).toEqual([
      expect.objectContaining({
        templateName: "two-factor-verification-code.hbs",
        token: expect.stringMatching(/^\d{6}$/),
      }),
    ]);

    mail.release(new Error("connection timeout"));
    await settle();

    expect(logged).toEqual([
      expect.objectContaining({
        userId: "user-1",
        message: "two-factor code e-mail could not be sent",
      }),
    ]);
    // The code itself never reaches the log.
    expect(JSON.stringify(logged)).not.toContain(mail.sent[0].token);
  });
});

describe("a password change", () => {
  it("answers before the notice is sent", async () => {
    await account();

    const update = new UpdateUserPasswordUseCase(users as never);

    await update.execute({
      userId: "user-1",
      currentPassword: PASSWORD,
      newPassword: "outra-senha-forte",
    });

    expect(mail.sent.map((sent) => sent.templateName)).toEqual([
      "user-password-updated.hbs",
    ]);

    mail.release();
    await settle();

    expect(logged).toEqual([]);
  });
});
