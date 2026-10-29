import { Writable } from "node:stream";

import fastify, { FastifyInstance } from "fastify";
import { hash } from "bcrypt";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed login, as the logs remember it (OBS-13).
 *
 * A wrong password was answered 401 straight from the controller, without the
 * error handler, so the only trace was the generic "request completed" line:
 * status 401, url /user/session — no account, no reason, and a remoteAddress
 * that was the reverse proxy's. After a credential-stuffing run there was no
 * way to tell which accounts were targeted nor where it came from.
 *
 * Now each failure is one warn line with the reason, the user id when there
 * is one, a keyed fingerprint of the e-mail (to group attempts on one account
 * without writing the address into the logs) and the client's address as the
 * rate limiter resolves it.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "RATE_LIMIT_TRUSTED_PROXY"
          ? "xff"
          : target[key as keyof typeof target],
    }),
  };
});

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async () => undefined,
}));

import { AuthenticateUserController } from "@/modules/user/usecases/authenticate-user/authenticate-user-controller";
import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { UserInvalidCredentialsError } from "@/modules/user/usecases/errors/user-invalid-credentials-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

const EMAIL = "vitima@exemplo.com.br";
const PASSWORD = "a-senha-certa";

let lines: Array<Record<string, unknown>> = [];
let raw = "";
let app: FastifyInstance;
let users: InMemoryUserRepository;

beforeEach(async () => {
  lines = [];
  raw = "";

  users = new InMemoryUserRepository();
  users.user.push({
    id: "user-1",
    name: "Pessoa Visada",
    email: EMAIL,
    password: await hash(PASSWORD, 4),
    role: "MASTER",
    businessId: null,
    session_version: 0,
    two_factor_enabled: false,
    email_verified: new Date(),
    access_revoked: false,
  } as never);

  const useCase = new AuthenticateUserUseCase(
    users as never,
    new InMemoryUserTokensRepository() as never,
    new InMemoryDriverRepository() as never,
  );

  vi.spyOn(container, "resolve").mockReturnValue(useCase as never);

  const capture = new Writable({
    write(chunk, _encoding, done) {
      raw += chunk.toString();
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
      done();
    },
  });

  app = fastify({ logger: { level: "info", stream: capture } });
  app.post("/user/session", new AuthenticateUserController().handle);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

const attempt = (email: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    headers: {
      // What production's proxy chain hands over: whatever the client wrote,
      // then the address the proxy actually saw.
      "x-forwarded-for": "198.51.100.7, 203.0.113.9",
    },
    payload: { email, password },
  });

const failures = () =>
  lines.filter((line) => line.event === "auth.login_failed");

describe("a wrong password", () => {
  it("leaves a warn line with the reason, the user and where it came from", async () => {
    const response = await attempt(EMAIL, "senha-errada");

    expect(response.statusCode).toBe(401);

    const [failure] = failures();

    expect(failure).toMatchObject({
      level: 40,
      reason: "wrong_password",
      userId: "user-1",
      clientAddress: "203.0.113.9",
    });
    expect(failure.account).toMatch(/^[0-9a-f]{16}$/);
  });

  it("never writes the e-mail nor the password into the logs", async () => {
    await attempt(EMAIL, "senha-errada");

    expect(raw.toLowerCase()).not.toContain(EMAIL);
    expect(raw).not.toContain("senha-errada");
  });
});

describe("an unknown e-mail", () => {
  it("is logged as such, with no user", async () => {
    await attempt("ninguem@exemplo.com.br", "qualquer-senha");

    const [failure] = failures();

    expect(failure).toMatchObject({
      reason: "unknown_email",
      userId: null,
      clientAddress: "203.0.113.9",
    });
  });
});

describe("the account fingerprint", () => {
  it("groups attempts on one account, whatever the spelling, and tells accounts apart", async () => {
    await attempt(EMAIL, "senha-errada-1");
    await attempt(EMAIL.toUpperCase(), "senha-errada-2");
    await attempt("outra@exemplo.com.br", "senha-errada-3");

    const [first, second, other] = failures().map((line) => line.account);

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("the error itself", () => {
  it("carries the reason the use case refused for", async () => {
    const error = await container
      .resolve(AuthenticateUserUseCase)
      .execute({ email: EMAIL, password: "senha-errada" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UserInvalidCredentialsError);
    expect(error).toMatchObject({ reason: "wrong_password", userId: "user-1" });

    // The sentence the client sees does not change.
    expect((error as Error).message).toBe("Credenciais inválidas!");
  });
});
