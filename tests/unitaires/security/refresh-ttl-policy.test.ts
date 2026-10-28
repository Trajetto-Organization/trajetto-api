import "reflect-metadata";

import { decode } from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/websocket` reaches the socket server and the Prisma singleton; the
 * reuse branch calls it, and the double lets the tests see that it did not.
 */
const securityEvents = vi.hoisted(() => [] as string[]);

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (_userId: string, event: { reason: string }) => {
    securityEvents.push(event.reason);
  },
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { createUserSession } from "@/modules/user/services/session-service";
import { RefreshTokenUseCase } from "@/modules/user/usecases/refresh-token/refresh-token-usecase";

/**
 * How long a session may sit unused, per client (AUTH-07).
 *
 * The refresh token lived one day, for everybody. The driver's app is built
 * to work offline for a week — cached data, a queue that survives restarts —
 * but a phone that spent 25 hours without signal came back to a refresh token
 * the API refused, and the app logged the driver out right when the queue
 * tried to send the proofs of delivery it had been holding. The mobile
 * session now idles for seven days, bounded by an absolute 30 days from the
 * login; the web keeps its day.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let refresh: RefreshTokenUseCase;
let userId: string;

const driverRepositoryStub = { findDriverById: async () => null };

beforeEach(async () => {
  vi.useFakeTimers();

  // Not on a whole second: the JWT's `exp` is in seconds, the row in
  // milliseconds, and only a clock between two seconds tells them apart.
  vi.setSystemTime(new Date("2026-09-24T08:00:00.600Z"));

  securityEvents.length = 0;
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  refresh = new RefreshTokenUseCase(
    users,
    tokens,
    driverRepositoryStub as never,
  );

  const user = await users.createUser({
    email: "motorista@exemplo.com.br",
    name: "Motorista",
    role: "BUSINESS_ADMIN",
    password: "nao-usado",
    businessId: "business-1",
  } as never);

  userId = user.id;
});

afterEach(() => {
  vi.useRealTimers();
});

async function login(client: "web" | "mobile"): Promise<string> {
  const user = await users.findUserById(userId);

  const session = await (
    createUserSession as (
      ...args: unknown[]
    ) => ReturnType<typeof createUserSession>
  )(user, tokens, client);

  return session.refresh_token;
}

describe("a mobile session", () => {
  it("still renews after 25 hours without a request", async () => {
    const token = await login("mobile");

    vi.advanceTimersByTime(25 * HOUR);

    const renewed = await refresh.execute(token);

    expect(renewed.refresh_token).toEqual(expect.any(String));
  });

  it("still renews after six days offline", async () => {
    const token = await login("mobile");

    vi.advanceTimersByTime(6 * DAY);

    await expect(refresh.execute(token)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("ends after more than seven idle days", async () => {
    const token = await login("mobile");

    vi.advanceTimersByTime(7 * DAY + HOUR);

    await expect(refresh.execute(token)).rejects.toMatchObject({
      name: "TokenExpiredError",
    });
  });

  it("keeps its policy across rotations, up to 30 days from the login", async () => {
    let token = await login("mobile");

    // A driver who comes back every six days keeps the session going…
    for (let day = 6; day <= 24; day += 6) {
      vi.advanceTimersByTime(6 * DAY);
      token = (await refresh.execute(token)).refresh_token;
    }

    // …until the absolute cap, counted from the login and not the last use.
    vi.advanceTimersByTime(6 * DAY + HOUR);

    await expect(refresh.execute(token)).rejects.toMatchObject({
      name: "TokenExpiredError",
    });

    // An ended session is not a stolen one.
    expect(securityEvents).toEqual([]);
    expect((await users.findUserById(userId))?.session_version).toBe(0);
  });
});

describe("a web session", () => {
  it("keeps today's one day", async () => {
    const token = await login("web");

    vi.advanceTimersByTime(25 * HOUR);

    await expect(refresh.execute(token)).rejects.toMatchObject({
      name: "TokenExpiredError",
    });
  });

  it("is what a login without a client gets", async () => {
    const user = await users.findUserById(userId);
    const { refresh_token } = await createUserSession(user!, tokens);

    const { exp, iat } = decode(refresh_token) as { exp: number; iat: number };

    expect(exp - iat).toBe(24 * 60 * 60);
  });
});

describe("the database row and the JWT", () => {
  it("expire at the same instant", async () => {
    const token = await login("mobile");

    const { exp } = decode(token) as { exp: number };
    const [row] = tokens.refreshTokenItems;

    // The row used to be computed a few milliseconds after the JWT was signed,
    // from a separate clock read, so the two never agreed exactly.
    expect(row.expires_in.getTime()).toBe(exp * 1000);
  });

  it("are issued at the instant the expiry was counted from", async () => {
    // `exp` came from one clock read and `iat` from the one jsonwebtoken
    // takes inside `sign`. A login at x.999 s put them in different seconds
    // and the token idled 604 799 s instead of seven days (the E2E caught it
    // in CI on 27/10/2026).
    // A clock that moves a second per read: any second read of it shows.
    let clock = new Date("2026-09-24T08:00:00.999Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));

    const token = await login("mobile");
    const { exp, iat } = decode(token) as { exp: number; iat: number };

    expect(exp - iat).toBe((7 * DAY) / 1000);
  });
});

describe("a refresh token whose row expired but was never spent", () => {
  it("is an ended session, not a replay", async () => {
    await tokens.createUserRefreshToken({
      userId,
      token_hash: "expired-hash",
      jti: "expired-jti",
      family_id: "family-1",
      expires_in: new Date(Date.now() - 1),
    });

    const outcome = await tokens.rotateUserRefreshToken({
      user_id: userId,
      current_jti: "expired-jti",
      current_token_hash: "expired-hash",
      replacement: {
        userId,
        token_hash: "next-hash",
        jti: "next-jti",
        family_id: "family-1",
        expires_in: new Date(Date.now() + DAY),
      },
      grace_ms: 60_000,
    });

    // "reused" logs the person out of every device and warns of a compromise.
    // A JWT that passed `verify` in its last millisecond reaches the row a
    // moment after the row lapsed, and landed there.
    expect(outcome.outcome).toBe("unknown");
  });
});

describe("a refresh token a sibling spent just before its row lapsed", () => {
  it("is an ended session, not a replay", async () => {
    const token = await login("web");

    // Two tabs, one token, at the very end of its life: the first one
    // rotates it while it is still live…
    await refresh.execute(token);

    // …and the second passed `verify` in the same instant but reaches the
    // row a moment after it lapsed. Spent moments ago, so no replay; lapsed,
    // so no sibling either.
    const [presented] = tokens.refreshTokenItems;
    presented.expires_in = new Date(Date.now() - 1);

    await expect(refresh.execute(token)).rejects.toMatchObject({
      code: "AUTH_SESSION_INVALIDATED",
    });

    expect(securityEvents).toEqual([]);
    expect((await users.findUserById(userId))?.session_version).toBe(0);
  });
});

describe("a refresh token presented again within the grace window", () => {
  /**
   * The grace is for a session racing itself — two tabs whose tokens expire
   * together, a phone retrying an answer it lost — and that is ONE extra
   * presentation. It used to mint a live token on every presentation inside
   * the minute, so a copy replayed shortly after the legitimate rotation got
   * a working session each time, silently.
   */
  it("serves two concurrent refreshes of one token, and logs nobody out", async () => {
    const token = await login("web");

    const [first, second] = await Promise.all([
      refresh.execute(token),
      refresh.execute(token),
    ]);

    expect(first.refresh_token).not.toBe(second.refresh_token);

    // Each tab holds a working token of its own.
    await expect(refresh.execute(first.refresh_token)).resolves.toBeTruthy();
    await expect(refresh.execute(second.refresh_token)).resolves.toBeTruthy();

    expect(securityEvents).toEqual([]);
    expect((await users.findUserById(userId))?.session_version).toBe(0);
  });

  it("treats a presentation past the grace allowance as reuse, even inside the window", async () => {
    const token = await login("web");

    await refresh.execute(token);

    // Three siblings: the parallel renewals of one page, tabs, a retry.
    for (let sibling = 0; sibling < 3; sibling += 1) {
      vi.advanceTimersByTime(5_000);
      await expect(refresh.execute(token)).resolves.toBeTruthy();
    }

    vi.advanceTimersByTime(5_000);

    await expect(refresh.execute(token)).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_REFRESH_REUSED",
    });

    // The existing reuse path: the family is gone, every session of the
    // account ended, and the person is warned.
    expect(tokens.refreshTokenItems).toEqual([]);
    expect((await users.findUserById(userId))?.session_version).toBe(1);
    expect(securityEvents).toEqual(["session_compromised"]);
  });
});
