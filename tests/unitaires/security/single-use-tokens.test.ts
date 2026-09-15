import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/websocket` reaches the socket server and, through it, the Prisma
 * singleton. A unit file that imports it drags a database client into a suite
 * that has no database, which in this project has already meant a segfault
 * rather than a failing test.
 */
vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: vi.fn(),
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";
import { EmailVerificationUseCase } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-usecase";

import { UserInvalidTokenError } from "@/modules/user/usecases/errors/user-invalid-token-error";

/**
 * Single-use tokens, and what the request that loses the race decides.
 *
 * A first version of this file only called each use case twice in a row and
 * checked that the second was refused. Every mutation survived it, which was
 * the honest verdict: sequential reuse already worked before the fix, because
 * the second call found no token to read. The bug was never there.
 *
 * The bug is the window between reading the token and writing. Two requests
 * read the same live token, both pass every check, and both go on to write —
 * so what has to be pinned is what the LOSER does once the token it read has
 * been spent by somebody else. A fake cannot produce that window on its own
 * (one event loop, in order), so the fake below produces it on demand.
 *
 * `tests/E2E/single-use-tokens.test.ts` runs the same property against a real
 * Postgres with a separate client per attempt, where the window is real.
 */
const IN_AN_HOUR = (): Date => new Date(Date.now() + 60 * 60 * 1000);

/**
 * A tokens repository where somebody else always gets there first.
 *
 * `find` still answers — the token WAS live when this request read it — and
 * `consume` reports the loss. That is exactly the state a losing request is
 * in, and the only state that tells the two implementations apart.
 */
class TokensLostRace extends InMemoryUserTokensRepository {
  async consumeForgotPasswordVerificationToken(): Promise<boolean> {
    return false;
  }

  async consumeEmailVerificationToken(): Promise<boolean> {
    return false;
  }
}

const notificationServiceDouble = {
  createActivityIfEnabled: vi.fn(),
};

async function seedUser(
  users: InMemoryUserRepository,
  email: string,
): Promise<void> {
  await users.createUser({
    email,
    name: "Titular do Link",
    role: "BUSINESS_USER",
    password: "a-senha-antiga",
    businessId: "business-1",
    profileAccessId: "profile-1",
  });
}

describe("the in-memory fake", () => {
  it("reports the loss the second time, like the database does", async () => {
    const tokens = new InMemoryUserTokensRepository();

    const row = await tokens.createForgotPasswordVerificationToken({
      email: "fake@exemplo.com",
      token: "t",
      expires: IN_AN_HOUR(),
    });

    // A fake that always answered true would let every test agree with a
    // repository that can answer false — and false is the entire point.
    expect(await tokens.consumeForgotPasswordVerificationToken(row.id)).toBe(
      true,
    );

    expect(await tokens.consumeForgotPasswordVerificationToken(row.id)).toBe(
      false,
    );
  });
});

describe("a password reset that loses the race", () => {
  let users: InMemoryUserRepository;
  let tokens: TokensLostRace;
  let resetPassword: ResetUserPasswordUseCase;

  beforeEach(async () => {
    users = new InMemoryUserRepository();
    tokens = new TokensLostRace();

    resetPassword = new ResetUserPasswordUseCase(users, tokens);

    await seedUser(users, "perdedor@exemplo.com");

    await tokens.createForgotPasswordVerificationToken({
      email: "perdedor@exemplo.com",
      token: "o-token",
      expires: IN_AN_HOUR(),
    });
  });

  it("is refused", async () => {
    await expect(
      resetPassword.execute({ token: "o-token", password: "a-que-nao-vale" }),
    ).rejects.toBeInstanceOf(UserInvalidTokenError);
  });

  it("does not touch the password", async () => {
    await resetPassword
      .execute({ token: "o-token", password: "a-que-nao-vale" })
      .catch(() => undefined);

    const user = await users.findUserByEmail("perdedor@exemplo.com");

    // The old code ran the password update and the token delete side by side
    // in a `Promise.all`: the loser wrote anyway, and whoever finished last
    // decided the account's password.
    expect(user?.password).toBe("a-senha-antiga");
  });
});

describe("an e-mail confirmation that loses the race", () => {
  let users: InMemoryUserRepository;
  let tokens: TokensLostRace;
  let verifyEmail: EmailVerificationUseCase;

  beforeEach(async () => {
    users = new InMemoryUserRepository();
    tokens = new TokensLostRace();
    notificationServiceDouble.createActivityIfEnabled.mockClear();

    verifyEmail = new EmailVerificationUseCase(
      users,
      tokens,
      notificationServiceDouble as never,
    );

    await seedUser(users, "confirma@exemplo.com");

    await tokens.createEmailVerificationToken({
      email: "confirma@exemplo.com",
      token: "o-token",
      expires: IN_AN_HOUR(),
    });
  });

  it("is refused", async () => {
    await expect(verifyEmail.execute("o-token")).rejects.toBeInstanceOf(
      UserInvalidTokenError,
    );
  });

  it("does not mark the address as verified", async () => {
    await verifyEmail.execute("o-token").catch(() => undefined);

    const user = await users.findUserByEmail("confirma@exemplo.com");

    expect(user?.email_verified).toBeNull();
  });

  it("writes nothing to the activity feed", async () => {
    await verifyEmail.execute("o-token").catch(() => undefined);

    expect(
      notificationServiceDouble.createActivityIfEnabled,
    ).not.toHaveBeenCalled();
  });
});

describe("a token that has expired", () => {
  it("is refused without being spent", async () => {
    const users = new InMemoryUserRepository();
    const tokens = new InMemoryUserTokensRepository();

    const resetPassword = new ResetUserPasswordUseCase(users, tokens);

    await seedUser(users, "expirado@exemplo.com");

    await tokens.createForgotPasswordVerificationToken({
      email: "expirado@exemplo.com",
      token: "token-vencido",
      expires: new Date(Date.now() - 1000),
    });

    await expect(
      resetPassword.execute({ token: "token-vencido", password: "tanto-faz" }),
    ).rejects.toBeTruthy();

    // Burning an expired link here would hand an attacker a way to cancel
    // somebody else's pending reset by replaying it once it goes stale.
    expect(
      await tokens.findForgotPasswordVerificationTokenByToken("token-vencido"),
    ).not.toBeNull();
  });
});

describe("the ordinary path", () => {
  it("still resets the password when the token is there to spend", async () => {
    const users = new InMemoryUserRepository();
    const tokens = new InMemoryUserTokensRepository();

    const resetPassword = new ResetUserPasswordUseCase(users, tokens);

    await seedUser(users, "feliz@exemplo.com");

    await tokens.createForgotPasswordVerificationToken({
      email: "feliz@exemplo.com",
      token: "o-token",
      expires: IN_AN_HOUR(),
    });

    await expect(
      resetPassword.execute({ token: "o-token", password: "a-nova" }),
    ).resolves.toBeUndefined();

    const user = await users.findUserByEmail("feliz@exemplo.com");

    // Hashed, not stored — so the check is bcrypt's, not a string compare.
    const { compare } = await import("bcrypt");

    expect(await compare("a-nova", user!.password)).toBe(true);

    expect(
      await tokens.findForgotPasswordVerificationTokenByToken("o-token"),
    ).toBeNull();
  });
});
