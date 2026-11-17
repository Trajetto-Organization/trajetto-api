import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One signature check per authenticated request (F4-03).
 *
 * The rate limiter keys the bucket by the user the access token names, and
 * `ensureAuthenticated` then looks that user's session up: both used to run
 * `jsonwebtoken.verify` on the same header, so every request paid the HMAC
 * and the parse twice, and a flood the limiter refused still paid one each.
 * The limiter's verdict is now kept per request and the guard reuses it, with
 * the same refusals as before. The claims it read (`request.accessClaims`) are
 * what the panel budget charges before the session lookup (F2-28).
 */

const jwt = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("jsonwebtoken", async (importOriginal) => {
  const loaded = await importOriginal<{
    default?: typeof import("jsonwebtoken");
  }>();
  // A CommonJS package: its functions live on the default export.
  const actual = loaded.default ?? (loaded as typeof import("jsonwebtoken"));

  jwt.verify.mockImplementation(actual.verify as never);

  const mocked = { ...actual, verify: jwt.verify };

  return { ...mocked, default: mocked };
});

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

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { clientRateLimitKey } from "@/config/rate-limit";
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
      role: "BUSINESS_ADMIN",
      businessId: "business-1",
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

function fakeRequest(authorization: string) {
  return {
    headers: { authorization },
    socket: { remoteAddress: "10.20.30.40" },
    log: logger(),
  } as unknown as Parameters<typeof ensureAuthenticated>[0];
}

const reply = () =>
  ({ log: logger() }) as unknown as Parameters<typeof ensureAuthenticated>[1];

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.statusCode, code: error.code };
  }
}

beforeEach(() => {
  jwt.verify.mockClear();
  repositories.findUserById.mockReset().mockResolvedValue(USER);
  repositories.hasActiveRefreshTokenFamily.mockReset().mockResolvedValue(true);
  repositories.findDriverById.mockReset();
});

describe("an authenticated request", () => {
  it("verifies the access token once for the limiter and the session guard", async () => {
    const request = fakeRequest(`Bearer ${token({})}`);

    expect(clientRateLimitKey(request)).toBe("user:user-1");

    await ensureAuthenticated(request, reply());

    expect(request.user.id).toBe("user-1");
    expect(jwt.verify).toHaveBeenCalledTimes(1);
  });

  it("knows who is calling before the session lookup", () => {
    const request = fakeRequest(`Bearer ${token({})}`);

    clientRateLimitKey(request);

    expect(repositories.findUserById).not.toHaveBeenCalled();
    expect(request.accessClaims).toEqual({
      sub: "user-1",
      role: "BUSINESS_ADMIN",
      businessId: "business-1",
    });
  });

  it("reads the claims a driver or a platform token carries as they are", () => {
    const master = fakeRequest(
      `Bearer ${token({ role: "MASTER", businessId: null })}`,
    );

    clientRateLimitKey(master);

    expect(master.accessClaims).toEqual({
      sub: "user-1",
      role: "MASTER",
      businessId: null,
    });
  });

  it("never shares a verdict between two requests", async () => {
    const first = fakeRequest(`Bearer ${token({})}`);
    const second = fakeRequest(`Bearer ${token({}, "other-secret")}`);

    clientRateLimitKey(first);
    clientRateLimitKey(second);

    expect(jwt.verify).toHaveBeenCalledTimes(2);
    expect(second.accessClaims).toBeUndefined();
    expect(await refusalOf(() => ensureAuthenticated(second, reply()))).toEqual(
      { status: 401, code: "AUTH_TOKEN_INVALID" },
    );
    expect(jwt.verify).toHaveBeenCalledTimes(2);
  });
});

describe("a token that does not verify", () => {
  it("is checked once and refused by the guard with the same code", async () => {
    const request = fakeRequest(`Bearer ${token({}, "other-secret")}`);

    expect(clientRateLimitKey(request)).toBe("ip:10.20.30.40");
    expect(
      await refusalOf(() => ensureAuthenticated(request, reply())),
    ).toEqual({ status: 401, code: "AUTH_TOKEN_INVALID" });

    expect(jwt.verify).toHaveBeenCalledTimes(1);
    expect(request.accessClaims).toBeUndefined();
    expect(repositories.findUserById).not.toHaveBeenCalled();
  });

  it("names nobody when it is not an access token", async () => {
    const request = fakeRequest(`Bearer ${token({ tokenType: "refresh" })}`);

    expect(clientRateLimitKey(request)).toBe("ip:10.20.30.40");
    expect(request.accessClaims).toBeUndefined();
    expect(
      await refusalOf(() => ensureAuthenticated(request, reply())),
    ).toEqual({ status: 401, code: "AUTH_TOKEN_INVALID" });
    expect(jwt.verify).toHaveBeenCalledTimes(1);
  });
});
