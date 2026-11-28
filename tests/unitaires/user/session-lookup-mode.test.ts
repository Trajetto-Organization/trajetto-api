import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which path reads the session (plano-escala F4-05).
 *
 * `single` asks SessionRepository.loadSession once: the user and whether the
 * refresh-token family is still active, in one statement. `legacy` is the
 * path every authenticated request took before it, kept for two releases as
 * the rollback: findUserById, and the family asked only when the checks
 * before it passed. ensureAuthenticated and the socket handshake call the
 * family last in both modes, so their order and codes do not depend on the
 * mode; what changes is only how many round trips it took.
 */

const repositories = vi.hoisted(() => ({
  loadSession: vi.fn(),
  findUserById: vi.fn(),
  hasActiveRefreshTokenFamily: vi.fn(),
}));

vi.mock("@/modules/user/repositories/session-repository", () => ({
  SessionRepository: class {
    loadSession = repositories.loadSession;
  },
}));

vi.mock("@/modules/user/repositories/user-repository", () => ({
  UserRepository: class {
    findUserById = repositories.findUserById;
  },
}));

vi.mock("@/modules/user/repositories/user-tokens-repository", () => ({
  UserTokensRepository: class {
    hasActiveRefreshTokenFamily = repositories.hasActiveRefreshTokenFamily;
  },
}));

import { env } from "@/env";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import { lookUpSession } from "@/modules/user/services/session-lookup";

const USER = { id: "user-1", session_version: 3 };

const initialMode = env.SESSION_LOOKUP_MODE;

beforeEach(() => {
  repositories.loadSession
    .mockReset()
    .mockResolvedValue({ user: USER, hasActiveFamily: true });
  repositories.findUserById.mockReset().mockResolvedValue(USER);
  repositories.hasActiveRefreshTokenFamily.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  env.SESSION_LOOKUP_MODE = initialMode;
});

describe("SESSION_LOOKUP_MODE=single", () => {
  beforeEach(() => {
    env.SESSION_LOOKUP_MODE = "single";
  });

  it("asks the session repository once and nothing else", async () => {
    const session = await lookUpSession("user-1", "family-1");

    expect(session.user).toBe(USER);
    expect(await session.familyActive()).toBe(true);

    expect(repositories.loadSession).toHaveBeenCalledTimes(1);
    expect(repositories.loadSession).toHaveBeenCalledWith("user-1", "family-1");
    expect(repositories.findUserById).not.toHaveBeenCalled();
    expect(repositories.hasActiveRefreshTokenFamily).not.toHaveBeenCalled();
  });

  it("answers the family from the same statement, ended or not", async () => {
    repositories.loadSession.mockResolvedValueOnce({
      user: USER,
      hasActiveFamily: false,
    });

    const session = await lookUpSession("user-1", "family-1");

    expect(await session.familyActive()).toBe(false);
    expect(repositories.hasActiveRefreshTokenFamily).not.toHaveBeenCalled();
  });

  it("passes a missing user on as null", async () => {
    repositories.loadSession.mockResolvedValueOnce({
      user: null,
      hasActiveFamily: false,
    });

    expect((await lookUpSession("ghost", "family-1")).user).toBeNull();
  });

  it("lets a database error through, for the caller to classify", async () => {
    const down = new Error("Can't reach database server");
    repositories.loadSession.mockRejectedValueOnce(down);

    await expect(lookUpSession("user-1", "family-1")).rejects.toBe(down);
  });
});

describe("SESSION_LOOKUP_MODE=legacy", () => {
  beforeEach(() => {
    env.SESSION_LOOKUP_MODE = "legacy";
  });

  it("reads the user as before and never the one-statement lookup", async () => {
    const session = await lookUpSession("user-1", "family-1");

    expect(session.user).toBe(USER);
    expect(repositories.findUserById).toHaveBeenCalledWith("user-1");
    expect(repositories.loadSession).not.toHaveBeenCalled();
  });

  it("asks for the family only when the caller gets that far", async () => {
    repositories.hasActiveRefreshTokenFamily.mockResolvedValueOnce(false);

    const session = await lookUpSession("user-1", "family-1");

    // A refused version or an ineligible user never reaches the family:
    // that round trip was not paid before, and is not paid now.
    expect(repositories.hasActiveRefreshTokenFamily).not.toHaveBeenCalled();

    expect(await session.familyActive()).toBe(false);
    expect(repositories.hasActiveRefreshTokenFamily).toHaveBeenCalledWith(
      "user-1",
      "family-1",
    );
  });
});

describe("the variable", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (value?: string) =>
    envSchema.safeParse(
      definedEnv(
        value === undefined ? BASE : { ...BASE, SESSION_LOOKUP_MODE: value },
      ),
    );

  it("defaults to single, absent or empty", () => {
    for (const value of [undefined, ""]) {
      const parsed = parse(value);

      expect(parsed.success).toBe(true);
      expect(parsed.data?.SESSION_LOOKUP_MODE).toBe("single");
    }
  });

  it("takes legacy as the rollback and refuses anything else", () => {
    expect(parse("legacy").data?.SESSION_LOOKUP_MODE).toBe("legacy");
    expect(parse("cached").success).toBe(false);
  });
});
