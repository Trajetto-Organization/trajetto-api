import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/websocket` reaches the socket server and, through it, the Prisma
 * singleton. Mocking it keeps a database client out of a suite that has none —
 * and it is also the thing under test here, so it has to be observable.
 */
const sendSecurityEventToUser = vi.fn();

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (...args: unknown[]) =>
    sendSecurityEventToUser(...args),
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UserRevokeAccessUseCase } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-usecase";
import { ToggleConflictError } from "@/modules/business/usecases/errors/toggle-conflict-error";

/**
 * Revoking access, and the event that must not be sent.
 *
 * The write was the easy half. The half that bites is the socket event: two
 * administrators acting on the same account at once — one revoking, one
 * restoring — both read the old value, both wrote, and BOTH pushed a security
 * event. The row ended up with whichever query landed last, so the user could
 * be told "your access was restored" and stay locked out, or be thrown out of
 * a session nobody revoked.
 *
 * `tests/E2E/toggle-preconditions.test.ts` proves only one of six parallel
 * flips reaches the database. This file proves the loser stays quiet.
 */
const CARRIER = "business-1";
const ADMIN = "admin-1";

/** A repository where somebody else always flips first. */
class UsersLostRace extends InMemoryUserRepository {
  async toggleUserAccessRevocation(): Promise<boolean> {
    return false;
  }
}

async function seed(users: InMemoryUserRepository): Promise<string> {
  await users.createUser({
    email: "admin@exemplo.com",
    name: "Administrador",
    role: "BUSINESS_ADMIN",
    password: "x",
    businessId: CARRIER,
    profileAccessId: "profile-1",
  });

  // The in-memory repository mints its own ids, so the admin is found by
  // e-mail and given the id the use case will be called with.
  const admin = await users.findUserByEmail("admin@exemplo.com");
  (admin as { id: string }).id = ADMIN;

  await users.createUser({
    email: "alvo@exemplo.com",
    name: "Alvo",
    role: "BUSINESS_USER",
    password: "x",
    businessId: CARRIER,
    profileAccessId: "profile-1",
  });

  const target = await users.findUserByEmail("alvo@exemplo.com");

  return target!.id;
}

describe("the in-memory fake", () => {
  /**
   * Mirrors the database, including refusing.
   *
   * A mutation that made the fake flip unconditionally survived every test
   * above: the conflict cases use a subclass that always loses, and the happy
   * cases only check that the flip happened — which it does either way. A fake
   * that cannot refuse makes every test agree with a repository that can, and
   * refusing is the property.
   */
  it("refuses when the expected state does not match", async () => {
    const users = new InMemoryUserRepository();
    const targetId = await seed(users);

    // The row says "not revoked"; this caller believes it is revoked.
    expect(await users.toggleUserAccessRevocation(targetId, true)).toBe(false);

    expect((await users.findUserById(targetId))?.access_revoked).toBe(false);
  });

  it("flips when it does match", async () => {
    const users = new InMemoryUserRepository();
    const targetId = await seed(users);

    expect(await users.toggleUserAccessRevocation(targetId, false)).toBe(true);

    expect((await users.findUserById(targetId))?.access_revoked).toBe(true);
  });
});

describe("when another administrator flips first", () => {
  let users: UsersLostRace;
  let revokeAccess: UserRevokeAccessUseCase;
  let targetId = "";

  beforeEach(async () => {
    sendSecurityEventToUser.mockClear();

    users = new UsersLostRace();
    revokeAccess = new UserRevokeAccessUseCase(users);

    targetId = await seed(users);
  });

  it("refuses with a conflict", async () => {
    await expect(
      revokeAccess.execute({ id: ADMIN, userId: targetId }),
    ).rejects.toBeInstanceOf(ToggleConflictError);
  });

  it("sends no security event", async () => {
    await revokeAccess
      .execute({ id: ADMIN, userId: targetId })
      .catch(() => undefined);

    // The event is what reaches the person's screen and closes their session.
    // Sending it for a write that did not happen is worse than the lost write.
    expect(sendSecurityEventToUser).not.toHaveBeenCalled();
  });
});

describe("when the flip lands", () => {
  let users: InMemoryUserRepository;
  let revokeAccess: UserRevokeAccessUseCase;
  let targetId = "";

  beforeEach(async () => {
    sendSecurityEventToUser.mockClear();

    users = new InMemoryUserRepository();
    revokeAccess = new UserRevokeAccessUseCase(users);

    targetId = await seed(users);
  });

  it("revokes and says so", async () => {
    await revokeAccess.execute({ id: ADMIN, userId: targetId });

    expect((await users.findUserById(targetId))?.access_revoked).toBe(true);

    expect(sendSecurityEventToUser).toHaveBeenCalledWith(targetId, {
      reason: "access_revoked",
    });
  });

  it("restores and says so", async () => {
    await revokeAccess.execute({ id: ADMIN, userId: targetId });
    sendSecurityEventToUser.mockClear();

    await revokeAccess.execute({ id: ADMIN, userId: targetId });

    expect((await users.findUserById(targetId))?.access_revoked).toBe(false);

    // The reason follows the state that was actually written, not the caller's
    // intention: the two used to be able to disagree.
    expect(sendSecurityEventToUser).toHaveBeenCalledWith(targetId, {
      reason: "access_restored",
    });
  });
});
