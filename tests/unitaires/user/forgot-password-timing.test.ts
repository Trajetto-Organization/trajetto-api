import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Forgot my password", and what its duration tells about the address
 * (GAP3-11, AUTH-06).
 *
 * The answer is the same sentence whether or not the e-mail has an account.
 * But an unknown address returned at once, while a registered one waited for
 * the reset e-mail to be SENT — in-process, through the provider, hundreds of
 * milliseconds — before answering. And when the provider failed, only a
 * registered address got a 500. Both told anybody which e-mails exist.
 *
 * The e-mail now leaves the response path: the link is stored before the
 * answer, the sending happens after it, and a failure is logged instead of
 * answered. It still never goes through the outbox, since it carries the
 * reset secret (ADR: mails carrying secrets never ride the outbox).
 */
let mailBehaviour: "hang" | "fail" | "ok" = "ok";
const mailed: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: ({ email }: { email: string }) => {
    mailed.push(email);

    if (mailBehaviour === "hang") return new Promise(() => undefined);
    if (mailBehaviour === "fail") {
      return Promise.reject(new Error("provider down"));
    }

    return Promise.resolve();
  },
}));

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";

import { clearLogged, logged } from "../../support/log-capture";

const EXISTING = "cadastrado@exemplo.com.br";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let useCase: SendForgotPasswordMailUseCase;

/** Resolves to "timeout" when the promise takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms = 200) {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

beforeEach(async () => {
  mailBehaviour = "ok";
  mailed.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  await users.createUser({
    email: EXISTING,
    name: "Pessoa Cadastrada",
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
  } as never);

  useCase = new SendForgotPasswordMailUseCase(users, tokens);
});

describe("a registered address", () => {
  it("is answered without waiting for the e-mail to be sent", async () => {
    mailBehaviour = "hang";

    expect(await within(useCase.execute(EXISTING))).toBe("settled");

    // Sent all the same, and the link it carries was stored first.
    expect(mailed).toEqual([EXISTING]);
    expect(
      await tokens.findForgotPasswordVerificationTokenByEmail(EXISTING),
    ).not.toBeNull();
  });

  it("gets the same answer when the provider fails (logged, not a 500)", async () => {
    mailBehaviour = "fail";
    clearLogged();

    expect(await within(useCase.execute(EXISTING))).toBe("settled");

    // Let the background failure land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged("error")).toHaveLength(1);
    expect(JSON.stringify(logged())).not.toContain(EXISTING);
  });
});

describe("an unknown address", () => {
  it("is answered the same way, and nothing is sent", async () => {
    expect(await within(useCase.execute("ninguem@exemplo.com.br"))).toBe(
      "settled",
    );

    expect(mailed).toEqual([]);
  });
});
