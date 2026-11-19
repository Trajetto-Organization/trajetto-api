import { sign } from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureAuthenticated with the session cache (plano-escala F5-23, ADR
 * 0015), at unit level: which requests may skip the session read, and that
 * the guards that depend on the request still run when one does.
 *
 *  - only on a route that opted in (`config.sessionCache`) and only with
 *    SESSION_CACHE_TTL_MS on: every other request reads the session;
 *  - never a MASTER's session;
 *  - with the revocation feed not fresh, every request reads the session;
 *  - a revocation made in this process (the security helpers of
 *    websocket.ts call forgetCachedSessions) is seen by the very next
 *    request;
 *  - a cached session still meets the tenant guard of THIS request.
 *
 * The repositories are stand-ins counting the reads; the feed is a stand-in
 * that says whether it is fresh.
 */

const repositories = vi.hoisted(() => ({
  loadSession: vi.fn(),
  findDriverById: vi.fn(),
}));

const feed = vi.hoisted(() => ({
  fresh: vi.fn(() => true),
  listen: vi.fn(() => () => undefined),
  nudge: vi.fn(),
}));

vi.mock("@/modules/user/repositories/session-repository", () => ({
  SessionRepository: class {
    loadSession = repositories.loadSession;
  },
}));

vi.mock("@/modules/driver/repositories/driver-repository", () => ({
  DriverRepository: class {
    findDriverById = repositories.findDriverById;
  },
}));

vi.mock("@/shared/auth/revocation-feed", () => ({
  revocationFeed: () => feed,
}));

import auth from "@/config/auth";
import { env } from "@/env";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import {
  forgetCachedSessions,
  resetSessionCache,
} from "@/shared/auth/session-cache";
import { AppError } from "@/shared/errors/AppError";

const ADMIN = {
  id: "user-1",
  role: "BUSINESS_ADMIN",
  businessId: "business-1",
  profileAccessId: null,
  session_version: 3,
  access_revoked: false,
  driverId: null,
  profileAccess: null,
  business: {
    is_active: true,
    timezone: "America/Sao_Paulo",
    entitlements: [{ module: "DELIVERIES", enabled: true }],
  },
};

const MASTER = { ...ADMIN, role: "MASTER", businessId: null, business: null };

const token = (sub = "user-1") =>
  sign(
    { sub, tokenType: "access", sessionVersion: 3, familyId: "family-1" },
    auth.secret_token,
    { expiresIn: "1h" },
  );

const logger = () => {
  const log = { child: vi.fn(), warn: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
};

function fakeRequest(
  options: {
    sub?: string;
    cached?: boolean;
    params?: Record<string, unknown>;
  } = {},
) {
  return {
    headers: { authorization: `Bearer ${token(options.sub)}` },
    log: logger(),
    params: options.params ?? {},
    query: {},
    routeOptions: {
      config: options.cached === false ? {} : { sessionCache: true },
    },
  } as unknown as Parameters<typeof ensureAuthenticated>[0];
}

const reply = () =>
  ({ log: logger() }) as unknown as Parameters<typeof ensureAuthenticated>[1];

/** How many session reads `count` requests of the same token cost. */
async function readsFor(
  count: number,
  options: Parameters<typeof fakeRequest>[0] = {},
) {
  repositories.loadSession.mockClear();

  for (let index = 0; index < count; index++) {
    await ensureAuthenticated(fakeRequest(options), reply());
  }

  return repositories.loadSession.mock.calls.length;
}

const initialTtl = env.SESSION_CACHE_TTL_MS;

beforeEach(() => {
  resetSessionCache();
  env.SESSION_CACHE_TTL_MS = 10_000;
  feed.fresh.mockReturnValue(true);
  feed.listen.mockClear();
  repositories.loadSession.mockReset().mockImplementation(async (userId) => ({
    user: userId === "master-1" ? { ...MASTER, id: "master-1" } : ADMIN,
    hasActiveFamily: true,
  }));
});

afterEach(() => {
  env.SESSION_CACHE_TTL_MS = initialTtl;
  resetSessionCache();
});

describe("the session cache in ensureAuthenticated", () => {
  it("lets a route that opted in skip the session read, with the same user", async () => {
    const first = fakeRequest();
    const second = fakeRequest();

    await ensureAuthenticated(first, reply());
    await ensureAuthenticated(second, reply());

    expect(repositories.loadSession).toHaveBeenCalledTimes(1);
    expect(second.user).toEqual(first.user);
    // A copy per request: one request's change never reaches the next.
    expect(second.user).not.toBe(first.user);
  });

  it("is never asked on a route that did not opt in", async () => {
    expect(await readsFor(3, { cached: false })).toBe(3);
  });

  it("is off at SESSION_CACHE_TTL_MS=0, the default", async () => {
    env.SESSION_CACHE_TTL_MS = 0;

    expect(await readsFor(3)).toBe(3);
    expect(feed.listen).not.toHaveBeenCalled();
  });

  it("never keeps a MASTER's session", async () => {
    expect(await readsFor(3, { sub: "master-1" })).toBe(3);
  });

  it("reads the session on every request while the feed is not fresh", async () => {
    feed.fresh.mockReturnValue(false);

    expect(await readsFor(3)).toBe(3);
  });

  it("sees a revocation made in this process on the very next request", async () => {
    expect(await readsFor(2)).toBe(1);

    // What sendSecurityEventToSession does after a logout's commit.
    forgetCachedSessions("refresh_family", "family-1");

    repositories.loadSession.mockResolvedValueOnce({
      user: ADMIN,
      hasActiveFamily: false,
    });

    await expect(
      ensureAuthenticated(fakeRequest(), reply()),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_SESSION_INVALIDATED",
    });
  });

  it("still runs the tenant guard of the request it answers", async () => {
    await ensureAuthenticated(fakeRequest(), reply());

    const foreign = fakeRequest({ params: { businessId: "business-2" } });
    const refusal = await ensureAuthenticated(foreign, reply()).catch(
      (error: unknown) => error,
    );

    expect(repositories.loadSession).toHaveBeenCalledTimes(1);
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ statusCode: 403 });
  });
});
