import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  SESSION_USER_COLUMNS,
  SessionRepository,
} from "@/modules/user/repositories/session-repository";
import { InMemorySessionRepository } from "@/modules/user/repositories/in-memory/in-memory-session-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import {
  enterRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";

/**
 * The session in one statement (plano-escala F4-04), without a database.
 *
 * What the E2E cannot say cheaply: the raw SELECT names its columns by
 * hand, so a column added to the user model would be missing from the
 * session's user until somebody noticed; the lookup has to be the ONE call
 * to the client; and the user it read has to be left in the request's
 * memory, because the use case of that same request looks the user up again
 * (findUserById) and that second read is the one this item exists to save.
 * The equivalence with today's lookup, row by row, is
 * tests/E2E/session-lookup-equivalence.test.ts.
 */

const USER = "018f0000-0000-7000-8000-0000000000a1";
const FAMILY = "018f0000-0000-7000-8000-0000000000f1";

interface Captured {
  text: string;
  values: unknown[];
}

/** A row as Postgres hands it to $queryRaw: the user, the relations, the family. */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER,
    name: "Pessoa",
    role: "BUSINESS_ADMIN",
    businessId: "018f0000-0000-7000-8000-0000000000b1",
    access_revoked: false,
    session_version: 3,
    business: { is_active: true, entitlements: [] },
    profileAccess: null,
    driver: null,
    hasActiveFamily: true,
    ...overrides,
  };
}

/** A client with $queryRaw only: any other call would throw. */
function clientAnswering(rows: unknown[], captured: Captured[]) {
  return {
    $queryRaw: async (query: Prisma.Sql) => {
      captured.push({ text: query.text, values: query.values });

      return rows;
    },
  };
}

/** A user repository that counts what reaches the database. */
function countingUserRepository(calls: string[]) {
  return new UserRepository({
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push(where.id);

        return null;
      },
    },
  } as never);
}

/** A request, as the HTTP hook opens one (as request-scoped-user-cache does). */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const branch = new AsyncLocalStorage<number>();

  return branch.run(Math.random(), async () => {
    enterRequestContext({});

    return run();
  });
}

describe("the session's columns", () => {
  it("are every scalar column of the user model, in the model's order", () => {
    // Prisma's include reads every scalar; the raw SELECT reads the ones it
    // names. A new column on the user would otherwise be in the use case's
    // user and missing from the middleware's.
    expect([...SESSION_USER_COLUMNS]).toEqual(
      Object.keys(Prisma.UserScalarFieldEnum),
    );
  });
});

describe("loadSession", () => {
  it("is one call to the client, with the parameters cast to text", async () => {
    const captured: Captured[] = [];
    const repository = new SessionRepository(
      clientAnswering([sessionRow()], captured) as never,
    );

    await repository.loadSession(USER, FAMILY);

    expect(captured).toHaveLength(1);
    // Prisma 7 binds raw parameters with no type (ADR 0011): an uncast
    // parameter compared with a column is left to the planner to guess.
    const placeholders = captured[0].text.match(/\$\d+(::\w+)?/g) ?? [];

    expect(placeholders.length).toBe(captured[0].values.length);
    expect(placeholders.filter((item) => !item.includes("::"))).toEqual([]);
    expect(captured[0].values).toEqual(expect.arrayContaining([USER, FAMILY]));
  });

  it("splits the family's answer from the user", async () => {
    const repository = new SessionRepository(
      clientAnswering([sessionRow({ hasActiveFamily: false })], []) as never,
    );

    const session = await repository.loadSession(USER, FAMILY);

    expect(session.hasActiveFamily).toBe(false);
    expect(session.user).not.toHaveProperty("hasActiveFamily");
    expect(session.user).toMatchObject({ id: USER, session_version: 3 });
  });

  it("answers no user and no family when the id does not exist", async () => {
    const repository = new SessionRepository(clientAnswering([], []) as never);

    expect(await repository.loadSession(USER, FAMILY)).toEqual({
      user: null,
      hasActiveFamily: false,
    });
  });
});

describe("the request's memory after loadSession", () => {
  it("answers the use case's findUserById without the database", async () => {
    const calls: string[] = [];
    const repository = new SessionRepository(
      clientAnswering([sessionRow()], []) as never,
    );
    const users = countingUserRepository(calls);

    await inRequest(async () => {
      const { user } = await repository.loadSession(USER, FAMILY);

      expect(await users.findUserById(USER)).toBe(user);
    });

    expect(calls).toEqual([]);
  });

  it("remembers an unknown id as unknown, as findUserById does", async () => {
    const calls: string[] = [];
    const repository = new SessionRepository(clientAnswering([], []) as never);
    const users = countingUserRepository(calls);

    await inRequest(async () => {
      await repository.loadSession(USER, FAMILY);

      expect(await users.findUserById(USER)).toBeNull();
    });

    expect(calls).toEqual([]);
  });

  it("leaves nothing behind outside a request (the socket handshake)", async () => {
    // No request, no memory: a handshake or a worker that loaded a session
    // must not hand that user to whatever runs next on the branch.
    const calls: string[] = [];
    const repository = new SessionRepository(
      clientAnswering([sessionRow()], []) as never,
    );
    const users = countingUserRepository(calls);

    // `enterWith` binds a store to the rest of the branch, so a test that ran
    // after a request test would still be inside one: `exit` gets out.
    await withoutRequestContext(async () => {
      await repository.loadSession(USER, FAMILY);
      await users.findUserById(USER);
    });

    expect(calls).toEqual([USER]);
  });
});

describe("the in-memory twin", () => {
  it("orders permissions by id and modules by name, as the statement does", async () => {
    const tokens = new InMemoryUserTokensRepository();
    const users = new InMemoryUserRepository({ tokens });
    const profileId = "018f0000-0000-7000-8000-0000000000c1";
    const businessId = "018f0000-0000-7000-8000-0000000000b1";

    users.user.push({
      id: USER,
      name: "Pessoa",
      email: "pessoa@example.com",
      password: "hash",
      role: "BUSINESS_USER",
      businessId,
      profileAccessId: profileId,
      driverId: null,
      access_revoked: false,
    } as never);
    users.profiles.set(profileId, { name: "Operação", businessId });
    users.profilePermissions.set(profileId, [
      {
        id: "018f0000-0000-7000-8000-0000000000d2",
        permissionKey: "routes",
        action: "Rotas",
        canRead: true,
        canWrite: false,
      },
      {
        id: "018f0000-0000-7000-8000-0000000000d1",
        permissionKey: "vehicles",
        action: "Veículos",
        canRead: true,
        canWrite: true,
      },
    ]);
    users.businesses.set(businessId, {
      is_active: true,
      entitlements: [
        { module: "FLEET", enabled: true },
        { module: "DELIVERIES", enabled: false },
      ],
    });

    const session = await new InMemorySessionRepository(
      users,
      tokens,
    ).loadSession(USER, FAMILY);

    expect(
      session.user?.profileAccess?.permissions.map((item) => item.id),
    ).toEqual([
      "018f0000-0000-7000-8000-0000000000d1",
      "018f0000-0000-7000-8000-0000000000d2",
    ]);
    expect(
      session.user?.business?.entitlements?.map((item) => item.module),
    ).toEqual(["DELIVERIES", "FLEET"]);
    // The twin's seeds are not reordered under the other tests' feet.
    expect(
      users.profilePermissions.get(profileId)?.map((item) => item.id),
    ).toEqual([
      "018f0000-0000-7000-8000-0000000000d2",
      "018f0000-0000-7000-8000-0000000000d1",
    ]);
    expect(session.hasActiveFamily).toBe(false);
  });
});
