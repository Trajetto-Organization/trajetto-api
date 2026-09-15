import { describe, expect, it } from "vitest";

import { UserRepository } from "@/modules/user/repositories/user-repository";

import {
  enterRequestContext,
  requestCacheSize,
  withoutRequestContext,
} from "@/shared/http/request-context";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The session lookup, answered once per request instead of twice.
 *
 * Every authenticated request used to load the full user twice — once in
 * `ensureAuthenticated` to decide whether the session is real, and once again
 * inside the use case, which takes a `userId` and looks it up itself. With the
 * business, its entitlements and the profile's permissions riding along that
 * is three queries, on every request in the product.
 *
 * A cache in front of a permissions lookup is the kind of optimisation that
 * turns into a security bug, so the rules it has to keep are the point of this
 * file: it lives for ONE request, it forgets on any write, and outside a
 * request it does not exist at all.
 */
function repositoryOver(calls: string[]) {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push(where.id);

        return where.id === "missing"
          ? null
          : ({ id: where.id, role: "BUSINESS_ADMIN" } as never);
      },

      update: async () => ({}) as never,
    },
  };

  return new UserRepository(prisma as never);
}

/** A request, as the HTTP hook opens one. */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  // `enterRequestContext` uses `enterWith`, which binds the store to the rest
  // of the current branch — so each simulated request needs its own branch, or
  // the second one would inherit the first one's store and the isolation test
  // would pass for the wrong reason.
  const branch = new AsyncLocalStorage<number>();

  return branch.run(Math.random(), async () => {
    enterRequestContext({});

    return run();
  });
}

describe("loading the user inside one request", () => {
  it("asks the database once, however many times it is called", async () => {
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      await repository.findUserById("user-1");
      await repository.findUserById("user-1");
      await repository.findUserById("user-1");
    });

    expect(calls).toEqual(["user-1"]);
  });

  it("keeps different users apart", async () => {
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      await repository.findUserById("user-1");
      await repository.findUserById("user-2");
      await repository.findUserById("user-1");
    });

    expect(calls).toEqual(["user-1", "user-2"]);
  });

  it("remembers that an id does not exist", async () => {
    // The not-found path is the one a probing caller repeats, and it is the
    // same three-query lookup as any other.
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      expect(await repository.findUserById("missing")).toBeNull();
      expect(await repository.findUserById("missing")).toBeNull();
    });

    expect(calls).toEqual(["missing"]);
  });
});

describe("what a write does to the memory", () => {
  it("forgets, so the next read sees the write", async () => {
    // The whole risk of this cache in one test: a request that changes a user
    // and then reads it back must not be handed the version from before.
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      await repository.findUserById("user-1");

      await repository.updateUserName({ userId: "user-1", name: "Novo" });

      await repository.findUserById("user-1");
    });

    expect(calls).toEqual(["user-1", "user-1"]);
  });

  it("forgets EVERY user, not only the one that was written", async () => {
    // A write can move a profile or an entitlement, which every cached user of
    // that company carries a copy of. Forgetting one id would leave the others
    // describing permissions that no longer exist.
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      await repository.findUserById("user-1");
      await repository.findUserById("user-2");

      await repository.invalidateUserSessions("user-9");

      await repository.findUserById("user-1");
      await repository.findUserById("user-2");
    });

    expect(calls).toEqual(["user-1", "user-2", "user-1", "user-2"]);
  });

  it("forgets on a revocation, which is the one that must never be stale", async () => {
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      await repository.findUserById("user-1");

      await repository.updateUserAccessRevocation({
        userId: "user-1",
        accessRevokedAt: new Date(),
      } as never);

      await repository.findUserById("user-1");
    });

    expect(calls).toHaveLength(2);
  });
});

describe("the boundaries of the memory", () => {
  it("does not leak between two requests", async () => {
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(() => repository.findUserById("user-1"));
    await inRequest(() => repository.findUserById("user-1"));

    // Two requests, two lookups. Sharing them would be a process-wide cache
    // of permissions with no invalidation — somebody revokes an access
    // profile and the next requests still see the old one.
    expect(calls).toEqual(["user-1", "user-1"]);
  });

  it("does not cache at all outside a request", async () => {
    // Workers, cron jobs and scripts run with no store. They are long-lived,
    // and a memory that survived a whole cron run would be the stale-cache
    // problem wearing a different hat.
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    // `enterWith` binds the store to the rest of the current branch, so a
    // test that merely ran after a request test would still be inside one.
    // `exit` is how anything deliberately outside a request gets out.
    await withoutRequestContext(async () => {
      await repository.findUserById("user-1");
      await repository.findUserById("user-1");

      expect(requestCacheSize()).toBe(0);
    });

    expect(calls).toEqual(["user-1", "user-1"]);
  });

  it("holds only what was asked for", async () => {
    const calls: string[] = [];
    const repository = repositoryOver(calls);

    await inRequest(async () => {
      expect(requestCacheSize()).toBe(0);

      await repository.findUserById("user-1");

      expect(requestCacheSize()).toBe(1);

      await repository.findUserById("user-2");

      expect(requestCacheSize()).toBe(2);
    });
  });
});
