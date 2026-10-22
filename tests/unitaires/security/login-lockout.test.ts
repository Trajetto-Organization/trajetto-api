import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";
import {
  ADMIN_RESET_LINK_TTL_MS,
  issuePasswordSetupLink,
} from "@/modules/user/services/password-setup-link";
import { UserInvalidCredentialsError } from "@/modules/user/usecases/errors/user-invalid-credentials-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import {
  FAILED_LOGIN_WINDOW_MS,
  LOGIN_LOCK_MS,
  MAX_FAILED_LOGINS,
} from "@/shared/security/login-lockout-rules";

/**
 * Password guessing, bounded without Redis.
 *
 * The login's only brake was the route rate limit, which lives in Redis and
 * fails open (ADR 0002): with Redis down, slow, or simply a guess spread over
 * many addresses, an attacker could try passwords against a known address as
 * fast as bcrypt answered. The per-account count lives on the user row.
 */
// The reset tells the person's open sockets; there is no socket server here.
vi.mock("@/websocket", () => ({ sendSecurityEventToUser: () => {} }));

const EMAIL = "gestora@exemplo.com.br";
const PASSWORD = "senha-certa-123";
const WRONG = "senha-errada";

let users: InMemoryUserRepository;
let useCase: AuthenticateUserUseCase;

const start = new Date("2026-09-24T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);

  users = new InMemoryUserRepository();

  users.user.push({
    id: "user-1",
    name: "Gestora",
    email: EMAIL,
    password: await hash(PASSWORD, 4),
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
    email_verified: new Date("2026-01-01T00:00:00.000Z"),
    two_factor_enabled: false,
    access_revoked: false,
    session_version: 0,
  } as never);

  useCase = new AuthenticateUserUseCase(
    users as never,
    new InMemoryUserTokensRepository() as never,
    new InMemoryDriverRepository() as never,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const login = (password: string) => useCase.execute({ email: EMAIL, password });

const failTimes = async (times: number) => {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await expect(login(WRONG), `failure ${attempt + 1}`).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );
  }
};

const row = () => users.user.find((user) => user.id === "user-1")!;

describe("a run of wrong passwords", () => {
  it("locks the account: even the right password is refused", async () => {
    await failTimes(MAX_FAILED_LOGINS);

    // Without the lock this is a session: the whole point of the finding.
    await expect(login(PASSWORD)).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );
  });

  it("refuses with the same sentence as a wrong password", async () => {
    // A message of its own after ten failures would tell the sender that the
    // address has an account.
    const wrong = await login(WRONG).catch((error: Error) => error.message);

    await failTimes(MAX_FAILED_LOGINS - 1);

    const locked = await login(PASSWORD).catch((error: Error) => error.message);

    expect(locked).toBe(wrong);
  });

  it("lets the owner back in once the lock runs out, and clears the count", async () => {
    await failTimes(MAX_FAILED_LOGINS);

    vi.setSystemTime(new Date(start.getTime() + LOGIN_LOCK_MS + 1_000));

    await expect(login(PASSWORD)).resolves.toHaveProperty("token");

    expect(row()).toMatchObject({
      failed_login_attempts: 0,
      failed_login_at: null,
      login_locked_until: null,
    });
  });

  it("locks again at the first wrong password after a lock", async () => {
    await failTimes(MAX_FAILED_LOGINS);

    vi.setSystemTime(new Date(start.getTime() + LOGIN_LOCK_MS + 1_000));

    // One more guess, not ten more: the count is not reset by the lock.
    await failTimes(1);
    await expect(login(PASSWORD)).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );
  });
});

describe("what does not lock", () => {
  it("a success in between starts the count over", async () => {
    await failTimes(MAX_FAILED_LOGINS - 1);
    await expect(login(PASSWORD)).resolves.toHaveProperty("token");

    await failTimes(MAX_FAILED_LOGINS - 1);
    await expect(login(PASSWORD)).resolves.toHaveProperty("token");
  });

  it("failures further apart than the window never add up", async () => {
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS + 2; attempt += 1) {
      vi.setSystemTime(
        new Date(start.getTime() + attempt * (FAILED_LOGIN_WINDOW_MS + 1_000)),
      );

      await failTimes(1);
    }

    await expect(login(PASSWORD)).resolves.toHaveProperty("token");
  });
});

describe("the way out", () => {
  it("a new password clears an active lock", async () => {
    await failTimes(MAX_FAILED_LOGINS);

    await users.updateUserPassword({
      userId: "user-1",
      password: await hash("senha-nova-456", 4),
    });

    expect(row()).toMatchObject({
      failed_login_attempts: 0,
      login_locked_until: null,
    });

    await expect(
      useCase.execute({ email: EMAIL, password: "senha-nova-456" }),
    ).resolves.toHaveProperty("token");
  });

  it("so does the link an administrator sends (decision 4.9)", async () => {
    await failTimes(MAX_FAILED_LOGINS);

    // An administrator no longer types a password: the person gets a
    // single-use link and sets it, and that clears the lock too.
    const tokens = new InMemoryUserTokensRepository();
    const url = await issuePasswordSetupLink(
      tokens,
      EMAIL,
      ADMIN_RESET_LINK_TTL_MS,
    );
    const token = url.split("token=")[1];

    await new ResetUserPasswordUseCase(users as never, tokens as never).execute(
      {
        token,
        password: "senha-do-link-789",
      },
    );

    expect(row()).toMatchObject({
      failed_login_attempts: 0,
      login_locked_until: null,
    });

    await expect(
      useCase.execute({ email: EMAIL, password: "senha-do-link-789" }),
    ).resolves.toHaveProperty("token");
  });
});
