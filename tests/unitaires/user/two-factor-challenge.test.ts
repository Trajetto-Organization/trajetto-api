import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { hash } from "bcrypt";
import { verify } from "jsonwebtoken";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two-factor that is a second factor, not a first one (WEB-07).
 *
 * The code was not tied to the password step. `resend-two-factor-code` issued
 * a fresh code for any address with two-factor on, and
 * `two-factor-verification` opened a session from e-mail + code alone — so
 * someone with only the victim's e-mail could ask for codes and guess them:
 * five guesses per code, a new code a minute, per-address limits walked
 * around with more addresses. For the accounts that turned two-factor ON,
 * the password did not matter.
 *
 * Captcha on the web forms (the finding's proposal) would change nothing:
 * the API is public and the app calls it directly. The fix is in the API:
 * a password login with two-factor on returns a short-lived signed challenge,
 * and the code is accepted — and resent — only next to a challenge for the
 * same account.
 *
 * Old app binaries do not send it. Enforcement is therefore behind
 * TWO_FACTOR_CHALLENGE_REQUIRED (default off), to be switched on once the app
 * and the web that send it are out.
 */
let enforce = false;

vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "TWO_FACTOR_CHALLENGE_REQUIRED"
          ? enforce
          : target[key as keyof typeof target],
    }),
  };
});

const codes: Array<{ email: string; token: string }> = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({
    email,
    additionalVariablesProperties,
  }: {
    email: string;
    additionalVariablesProperties?: { token?: string };
  }) => {
    if (additionalVariablesProperties?.token) {
      codes.push({ email, token: additionalVariablesProperties.token });
    }
  },
}));

import auth from "@/config/auth";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { AuthenticateUserController } from "@/modules/user/usecases/authenticate-user/authenticate-user-controller";
import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";
import { TwoFactorVerificationController } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-controller";
import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";
import { ResendTwoFactorCodeController } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-controller";
import { UserInvalidTwoFactorCodeError } from "@/modules/user/usecases/errors/user-invalid-two-factor-code-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import {
  userResponses,
  userSchemas,
} from "@/routes/documentation/user-documentation";

const VICTIM = "vitima@exemplo.com.br";
const ATTACKER = "atacante@exemplo.com.br";
const PASSWORD = "a-senha-certa";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let drivers: InMemoryDriverRepository;

let login: AuthenticateUserUseCase;
let verification: TwoFactorVerificationUseCase;
let resend: ResendTwoFactorCodeUseCase;

async function account(id: string, email: string) {
  users.user.push({
    id,
    name: "Pessoa com 2FA",
    email,
    password: await hash(PASSWORD, 4),
    role: "MASTER",
    businessId: null,
    session_version: 0,
    two_factor_enabled: true,
    email_verified: new Date(),
    access_revoked: false,
  } as never);
}

/** A password login that stops at the two-factor step. */
async function passwordStep(email: string) {
  const result = await login.execute({ email, password: PASSWORD });
  const mine = codes.filter((entry) => entry.email === email);
  const code = mine[mine.length - 1].token;

  return { challenge: result.twoFactorChallenge, code };
}

beforeEach(async () => {
  enforce = false;
  codes.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  drivers = new InMemoryDriverRepository();

  await account("victim-1", VICTIM);
  await account("attacker-1", ATTACKER);

  login = new AuthenticateUserUseCase(users as never, tokens as never, drivers as never);
  verification = new TwoFactorVerificationUseCase(
    users as never,
    tokens as never,
    drivers as never,
  );
  resend = new ResendTwoFactorCodeUseCase(users as never, tokens as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the password step", () => {
  it("hands out a challenge for the two-factor step", async () => {
    const { challenge } = await passwordStep(VICTIM);

    expect(typeof challenge).toBe("string");
  });

  it("that is not an access token", async () => {
    const { challenge } = await passwordStep(VICTIM);

    expect(() => verify(challenge!, auth.secret_token)).toThrow();
  });
});

describe("with the challenge enforced", () => {
  beforeEach(() => {
    enforce = true;
  });

  it("no code is sent to someone who only knows the e-mail", async () => {
    const answer = await resend.execute(VICTIM);

    expect(codes).toEqual([]);
    expect(tokens.twoFactorTokens).toEqual([]);
    // Still the one neutral sentence.
    expect(answer.twoFactorVerificationMessage).toMatch(/Se esta conta/);
  });

  it("a right code without the challenge opens nothing", async () => {
    const { code } = await passwordStep(VICTIM);

    await expect(
      verification.execute({ email: VICTIM, twoFactorCode: code }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
  });

  it("nor with another account's challenge", async () => {
    const { code } = await passwordStep(VICTIM);
    const { challenge: attackers } = await passwordStep(ATTACKER);

    await expect(
      verification.execute({
        email: VICTIM,
        twoFactorCode: code,
        challenge: attackers,
      }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);

    // And the refusal did not spend one of the owner's five guesses.
    const stored = tokens.twoFactorTokens.find((entry) => entry.email === VICTIM);
    expect(stored?.attempts).toBe(0);
  });

  it("nor with a challenge issued before the password changed", async () => {
    const { code, challenge } = await passwordStep(VICTIM);

    users.user.find((row) => row.id === "victim-1")!.session_version = 1;

    await expect(
      verification.execute({ email: VICTIM, twoFactorCode: code, challenge }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
  });

  it("the owner, with the code and the challenge, gets in", async () => {
    const { code, challenge } = await passwordStep(VICTIM);

    const session = await verification.execute({
      email: VICTIM,
      twoFactorCode: code,
      challenge,
    });

    expect(session.token).toBeTruthy();
  });

  it("the owner can ask for another code with the challenge", async () => {
    const { challenge } = await passwordStep(VICTIM);

    // Past the one-code-per-minute rule.
    tokens.twoFactorTokens[0].expires = new Date(Date.now() + 5 * 60 * 1000);
    codes.length = 0;

    await resend.execute(VICTIM, challenge);

    expect(codes.map((entry) => entry.email)).toEqual([VICTIM]);
  });
});

describe("with the challenge not enforced (today's default)", () => {
  it("an app build that never heard of it still logs in", async () => {
    const { code } = await passwordStep(VICTIM);

    const session = await verification.execute({
      email: VICTIM,
      twoFactorCode: code,
    });

    expect(session.token).toBeTruthy();
  });

  it("and can still ask for another code", async () => {
    await resend.execute(VICTIM);

    expect(codes.map((entry) => entry.email)).toEqual([VICTIM]);
  });
});

describe("over HTTP", () => {
  async function appWith(
    route: string,
    handler: (request: never, reply: never) => Promise<unknown>,
    body: unknown,
    response?: unknown,
  ) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.post(
      route,
      { schema: { body, ...(response ? { response: { 200: response } } : {}) } } as never,
      handler as never,
    );
    await app.ready();
    return app;
  }

  it("the login answer carries the challenge past the response schema", async () => {
    vi.spyOn(container, "resolve").mockReturnValue(login as never);

    const app = await appWith(
      "/user/session",
      new AuthenticateUserController().handle,
      userSchemas.authenticateUser,
      userResponses.authenticateUserSuccess,
    );

    const response = await app.inject({
      method: "POST",
      url: "/user/session",
      payload: { email: VICTIM, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      twoFactorVerification: true,
      twoFactorChallenge: expect.any(String),
    });

    await app.close();
  });

  it("the verification body's challenge reaches the use case", async () => {
    const execute = vi.fn().mockResolvedValue({
      token: "t",
      refresh_token: "r",
      role: "MASTER",
    });
    vi.spyOn(container, "resolve").mockReturnValue({ execute } as never);

    const app = await appWith(
      "/user/two-factor-verification",
      new TwoFactorVerificationController().handle,
      userSchemas.twoFactorUser,
    );

    await app.inject({
      method: "POST",
      url: "/user/two-factor-verification",
      payload: { email: VICTIM, code: "123456", challenge: "o-desafio" },
    });

    expect(execute.mock.calls[0][0]).toMatchObject({ challenge: "o-desafio" });

    await app.close();
  });

  it("the resend body's challenge reaches the use case", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ twoFactorVerificationMessage: "ok" });
    vi.spyOn(container, "resolve").mockReturnValue({ execute } as never);

    const app = await appWith(
      "/user/resend-two-factor-code",
      new ResendTwoFactorCodeController().handle,
      userSchemas.resendTwoFactorCode,
    );

    await app.inject({
      method: "POST",
      url: "/user/resend-two-factor-code",
      payload: { email: VICTIM, challenge: "o-desafio" },
    });

    expect(execute.mock.calls[0]).toEqual([VICTIM, "o-desafio"]);

    await app.close();
  });

  it("an old client's body, without the challenge, is still accepted", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ twoFactorVerificationMessage: "ok" });
    vi.spyOn(container, "resolve").mockReturnValue({ execute } as never);

    const app = await appWith(
      "/user/resend-two-factor-code",
      new ResendTwoFactorCodeController().handle,
      userSchemas.resendTwoFactorCode,
    );

    const response = await app.inject({
      method: "POST",
      url: "/user/resend-two-factor-code",
      payload: { email: VICTIM },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
