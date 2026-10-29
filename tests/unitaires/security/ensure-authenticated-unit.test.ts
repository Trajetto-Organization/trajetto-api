import { Prisma } from "@prisma/client";
import { sign } from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureAuthenticated` at unit level (mutation run 06/10: only E2E suites
 * reached it, so every one of its branches had no coverage in the mutation
 * run). The repositories are stand-ins; the token check, the session rules
 * and the tenant guard are the real ones.
 */

const repositories = vi.hoisted(() => ({
  findUserById: vi.fn(),
  hasActiveRefreshTokenFamily: vi.fn(),
  findDriverById: vi.fn(),
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

vi.mock("@/modules/driver/repositories/driver-repository", () => ({
  DriverRepository: class {
    findDriverById = repositories.findDriverById;
  },
}));

import auth from "@/config/auth";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { AppError } from "@/shared/errors/AppError";

const USER = {
  id: "user-1",
  role: "BUSINESS_ADMIN",
  businessId: "business-1",
  session_version: 3,
  access_revoked: false,
  driverId: null,
  profileAccess: null,
  business: {
    id: "business-1",
    is_active: true,
    entitlements: [{ module: "FLEET", enabled: true }],
  },
};

const token = (payload: Record<string, unknown>, secret = auth.secret_token) =>
  sign(
    {
      sub: "user-1",
      tokenType: "access",
      sessionVersion: 3,
      familyId: "family-1",
      ...payload,
    },
    secret,
  );

const logger = () => {
  const log = { child: vi.fn(), warn: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
};

function fakeRequest(
  authorization: string | undefined,
  where: Record<string, unknown> = {},
) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    log: logger(),
    ...where,
  } as unknown as Parameters<typeof ensureAuthenticated>[0] & {
    user?: Record<string, unknown>;
  };
}

const reply = () =>
  ({ log: logger() }) as unknown as Parameters<typeof ensureAuthenticated>[1];

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
}

beforeEach(() => {
  repositories.findUserById.mockReset().mockResolvedValue(USER);
  repositories.hasActiveRefreshTokenFamily.mockReset().mockResolvedValue(true);
  repositories.findDriverById.mockReset();
});

describe("the token", () => {
  const MISSING = {
    status: 401,
    code: "AUTH_TOKEN_MISSING",
    message: "Token de autenticação ausente.",
  };

  it("is required as a Bearer token with something in it", async () => {
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest(undefined), reply()),
      ),
    ).toEqual(MISSING);
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest(`Basic ${token({})}`), reply()),
      ),
    ).toEqual(MISSING);
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest("Bearer    "), reply()),
      ),
    ).toEqual(MISSING);
  });

  it("must verify with the access secret", async () => {
    expect(
      await refusalOf(() =>
        ensureAuthenticated(
          fakeRequest(`Bearer ${token({}, "other-secret")}`),
          reply(),
        ),
      ),
    ).toEqual({
      status: 401,
      code: "AUTH_TOKEN_INVALID",
      message: "Token de autenticação inválido ou expirado.",
    });
  });

  it("must be an access token carrying a subject, a session version and a family", async () => {
    const INVALID = {
      status: 401,
      code: "AUTH_TOKEN_INVALID",
      message: "Token de autenticação inválido.",
    };

    for (const bad of [
      { sub: "" },
      { tokenType: "refresh" },
      { sessionVersion: "3" },
      { familyId: "" },
    ]) {
      expect(
        await refusalOf(() =>
          ensureAuthenticated(fakeRequest(`Bearer ${token(bad)}`), reply()),
        ),
      ).toEqual(INVALID);
    }
    expect(repositories.findUserById).not.toHaveBeenCalled();
  });
});

describe("the session", () => {
  it("ends when the user is gone, the version moved, or the family was closed", async () => {
    repositories.findUserById.mockResolvedValueOnce(null);
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest(`Bearer ${token({})}`), reply()),
      ),
    ).toEqual({
      status: 401,
      code: "AUTH_SESSION_INVALID",
      message: "Sessão inválida.",
    });

    repositories.findUserById.mockResolvedValueOnce({
      ...USER,
      session_version: 4,
    });
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest(`Bearer ${token({})}`), reply()),
      ),
    ).toEqual({
      status: 401,
      code: "AUTH_SESSION_INVALIDATED",
      message: "Sessão expirada ou invalidada.",
    });

    repositories.hasActiveRefreshTokenFamily.mockResolvedValueOnce(false);
    expect(
      await refusalOf(() =>
        ensureAuthenticated(fakeRequest(`Bearer ${token({})}`), reply()),
      ),
    ).toEqual({
      status: 401,
      code: "AUTH_SESSION_INVALIDATED",
      message: "Sessão expirada ou encerrada.",
    });
    expect(repositories.hasActiveRefreshTokenFamily).toHaveBeenLastCalledWith(
      "user-1",
      "family-1",
    );
  });

  it("reads a missing session version as zero", async () => {
    repositories.findUserById.mockResolvedValueOnce({
      ...USER,
      session_version: null,
    });

    const request = fakeRequest(`Bearer ${token({ sessionVersion: 0 })}`);
    await ensureAuthenticated(request, reply());

    expect(request.user?.sessionVersion).toBe(0);
  });

  it("puts the user, the session and the company's entitlements on the request", async () => {
    const request = fakeRequest(`  Bearer ${token({})}`.trim());
    const response = reply();

    await ensureAuthenticated(request, response);

    expect(request.user).toEqual({
      id: "user-1",
      role: "BUSINESS_ADMIN",
      businessId: "business-1",
      sessionVersion: 3,
      sessionId: "family-1",
      profileAccess: null,
      driverId: null,
      driver: null,
      entitlements: [{ module: "FLEET", enabled: true }],
    });
    expect(
      (request.log as unknown as { child: ReturnType<typeof vi.fn> }).child,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      businessId: "business-1",
    });
    expect(
      (response.log as unknown as { child: ReturnType<typeof vi.fn> }).child,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      businessId: "business-1",
    });
  });

  it("gives a user without a company null ids and null entitlements", async () => {
    repositories.findUserById.mockResolvedValueOnce({
      ...USER,
      role: "MASTER",
      businessId: null,
      business: null,
    });

    const request = fakeRequest(`Bearer ${token({})}`);
    await ensureAuthenticated(request, reply());

    expect(request.user).toMatchObject({
      businessId: null,
      entitlements: null,
    });
  });

  it("checks the tenant the request names", async () => {
    expect(
      await refusalOf(() =>
        ensureAuthenticated(
          fakeRequest(`Bearer ${token({})}`, {
            params: { businessId: "business-2" },
          }),
          reply(),
        ),
      ),
    ).toEqual({
      status: 403,
      code: "TENANT_ACCESS_DENIED",
      message: "Acesso negado aos dados desta empresa.",
    });
  });
});

describe("a database that does not answer", () => {
  it("is a 503, logged, never a 401", async () => {
    repositories.findUserById.mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError("down", "test"),
    );
    const request = fakeRequest(`Bearer ${token({})}`);

    expect(
      await refusalOf(() => ensureAuthenticated(request, reply())),
    ).toEqual({
      status: 503,
      code: "AUTH_SESSION_UNAVAILABLE",
      message: "Não foi possível verificar sua sessão agora. Tente novamente.",
    });
    expect(
      (request.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Prisma.PrismaClientInitializationError),
      }),
      "Session check failed: database unavailable",
    );
  });

  it("but a bug is passed on as it is", async () => {
    const bug = new TypeError("cannot read x of undefined");
    repositories.findUserById.mockRejectedValueOnce(bug);

    await expect(
      ensureAuthenticated(fakeRequest(`Bearer ${token({})}`), reply()),
    ).rejects.toBe(bug);
  });
});
