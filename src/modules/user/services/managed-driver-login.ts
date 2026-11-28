import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

import { User } from "../dtos/user-dto";
import { IUserRepository } from "../repositories/IUser-repository";

import { ResourceNotFoundError } from "../usecases/errors/resource-not-found-error";
import { UserNotDriverError } from "../usecases/errors/user-not-driver-error";

interface ManagedDriverLogin {
  actor: User;
  target: User;
}

/**
 * The driver's login a manager acts on (plan of 02/11/2026: the password the
 * manager sets, D2; the access QR code, D3; the phone list, D7).
 *
 * The path names the user by id, with no company in it, so the tenant check
 * lives here: another company's login answers exactly like a missing one
 * (404 USER_NOT_FOUND), never a 403 that would confirm the id exists. Only a
 * DRIVER's login qualifies — an office user keeps the e-mailed link and its
 * own sessions — and the role hierarchy needs no check of its own: a
 * driver's login is a plain user, which every role that reaches these routes
 * may manage.
 */
async function resolveManagedDriverLogin(
  users: Pick<IUserRepository, "findUserById">,
  actorId: string,
  userId: string,
): Promise<ManagedDriverLogin> {
  const actor = await users.findUserById(actorId);

  if (!actor) throw new ResourceNotFoundError();

  const target = await users.findUserById(userId);

  if (!target) throw new ResourceNotFoundError();

  assertTenantAccessToRecord(
    actor,
    target.businessId,
    () => new ResourceNotFoundError(),
  );

  if (target.role !== "BUSINESS_USER" || !target.driverId) {
    throw new UserNotDriverError();
  }

  return { actor, target };
}

export { resolveManagedDriverLogin };
export type { ManagedDriverLogin };
