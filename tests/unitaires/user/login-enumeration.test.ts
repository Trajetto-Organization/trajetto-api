import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";

/**
 * Which e-mails have an account, told by the clock (GAP3-11, AUTH-06).
 *
 * POST /user/session answers the same sentence for an unknown e-mail and for
 * a wrong password — but an unknown e-mail was refused BEFORE any bcrypt, and
 * a known one paid a cost-10 compare first: ~5 ms against ~60 ms, a gap that
 * survives the internet with a handful of samples. The route is anonymous and
 * the app calls it directly, with no captcha in front, so a list of e-mails
 * could be sorted into "has an account" and "has not" at 8 per minute per
 * address — the first step of a targeted credential-stuffing run.
 *
 * The unknown e-mail now pays the same compare, against a hash of the same
 * cost.
 */
vi.mock("@/shared/security/bcrypt-gate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/security/bcrypt-gate")>();

  return { ...original, compareSecret: vi.fn(original.compareSecret) };
});

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async () => undefined,
}));

import { compareSecret } from "@/shared/security/bcrypt-gate";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { UserInvalidCredentialsError } from "@/modules/user/usecases/errors/user-invalid-credentials-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

let users: InMemoryUserRepository;
let useCase: AuthenticateUserUseCase;

beforeEach(async () => {
  vi.mocked(compareSecret).mockClear();

  users = new InMemoryUserRepository();

  users.user.push({
    id: "user-1",
    name: "Pessoa Cadastrada",
    email: "existe@exemplo.com.br",
    password: await hash("a-senha-certa", 4),
    role: "MASTER",
    businessId: null,
    session_version: 0,
    two_factor_enabled: false,
    email_verified: new Date(),
    access_revoked: false,
  } as never);

  useCase = new AuthenticateUserUseCase(
    users as never,
    new InMemoryUserTokensRepository() as never,
    new InMemoryDriverRepository() as never,
  );
});

describe("an e-mail with no account", () => {
  it("pays the same bcrypt compare as a wrong password before being refused", async () => {
    await expect(
      useCase.execute({
        email: "ninguem@exemplo.com.br",
        password: "qualquer-senha",
      }),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);

    expect(compareSecret).toHaveBeenCalledTimes(1);
  });

  it("is compared against a hash of the same cost as real passwords (10)", async () => {
    await useCase
      .execute({ email: "ninguem@exemplo.com.br", password: "qualquer-senha" })
      .catch(() => undefined);

    const [, againstHash] = vi.mocked(compareSecret).mock.calls[0];

    expect(againstHash).toMatch(/^\$2[aby]\$10\$/);
  });
});

describe("an e-mail with an account and the wrong password", () => {
  it("is refused with the same error, after one compare", async () => {
    const unknown = await useCase
      .execute({ email: "ninguem@exemplo.com.br", password: "qualquer-senha" })
      .catch((error: Error) => error);

    vi.mocked(compareSecret).mockClear();

    const wrong = await useCase
      .execute({ email: "existe@exemplo.com.br", password: "senha-errada" })
      .catch((error: Error) => error);

    expect(compareSecret).toHaveBeenCalledTimes(1);
    expect(wrong).toBeInstanceOf(UserInvalidCredentialsError);
    expect((wrong as Error).message).toBe((unknown as Error).message);
  });
});
