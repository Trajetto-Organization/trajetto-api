import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { AppError } from "@/shared/errors/AppError";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * Planning is the dispatcher's job. Every write in this module that shapes a
 * route — creating it, editing it, releasing it, cancelling it, adding,
 * removing or reordering its stops — goes through here first.
 *
 * The departure is the exception and goes the other way: only the route's own
 * driver may start it, which start-route enforces itself.
 *
 * Inside the use case rather than as a preHandler, even though `request.user`
 * already carries `driverId` and the check would be free there. A guard that
 * lives only above the use case holds until the first caller that skips it —
 * a job, a script, the spreadsheet importer, another use case — and it fails
 * open. `start-driver-route` already calls straight into `start-route`, so
 * that caller is not hypothetical.
 *
 * The company too, for the same reason: checking the person and not the
 * company let another company's dispatcher who named this one plan it.
 */
async function assertRouteDispatcher(
  users: IUserRepository,
  userId: string,
  businessId: string,
): Promise<User> {
  const findUser = await users.findUserById(userId);

  // `ensureAuthenticated` already proved this user exists, so reaching here
  // means it was deleted between the token check and now. 401 rather than a
  // bare Error, which the handler would turn into a 500 and the driver's app
  // would retry forever.
  if (!findUser) {
    throw new AppError("Sessão inválida.", 401, "AUTH_SESSION_INVALID");
  }

  assertDispatcher(findUser);
  assertTenantAccess(findUser, businessId);

  return findUser;
}

export { assertRouteDispatcher };
