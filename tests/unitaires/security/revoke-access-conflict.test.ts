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
  // A driver's login going dark refreshes the chat pickers' "com o app".
  sendCatalogChangedEvent: () => undefined,
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UserRevokeAccessUseCase } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-usecase";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";
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
    revokeAccess = new UserRevokeAccessUseCase(
      users,
      new InMemoryDriverRepository(),
      new InMemoryDriverEnrollmentRepository(),
    );

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
    revokeAccess = new UserRevokeAccessUseCase(
      users,
      new InMemoryDriverRepository(),
      new InMemoryDriverEnrollmentRepository(),
    );

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

describe("revoking a driver's login", () => {
  /**
   * The access QR code still on the manager's screen dies with the access
   * (plan of 02/11/2026, D3/D5). While revoked it cannot be consumed anyway,
   * but restoring the access within its ten minutes used to bring it back: a
   * screenshot that went to the wrong person — often the very reason the
   * access was revoked — opened a session after the restore.
   */
  it("deletes the access QR code not yet used, and restoring does not bring it back", async () => {
    sendSecurityEventToUser.mockClear();

    const users = new InMemoryUserRepository();
    const enrollment = new InMemoryDriverEnrollmentRepository();
    const revokeAccess = new UserRevokeAccessUseCase(
      users,
      new InMemoryDriverRepository(),
      enrollment,
    );

    await seed(users);
    const driverLogin = await users.createUser({
      email: "motorista@exemplo.com",
      name: "Motorista",
      role: "BUSINESS_USER",
      password: "x",
      businessId: CARRIER,
      driverId: "driver-1",
    });

    await enrollment.issue({
      userId: driverLogin.id,
      businessId: CARRIER,
      token: "qr-token-on-screen",
      code: "ABCD2345",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdById: ADMIN,
    });

    await revokeAccess.execute({ id: ADMIN, userId: driverLogin.id });

    expect(await enrollment.findByToken("qr-token-on-screen")).toBeNull();

    await revokeAccess.execute({ id: ADMIN, userId: driverLogin.id });

    expect((await users.findUserById(driverLogin.id))?.access_revoked).toBe(
      false,
    );
    expect(await enrollment.findByToken("qr-token-on-screen")).toBeNull();
    expect(await enrollment.findByCode("ABCD2345")).toBeNull();
  });
});
