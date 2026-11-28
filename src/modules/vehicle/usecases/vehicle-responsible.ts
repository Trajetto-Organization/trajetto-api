import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";
import { assertAssignableUser } from "@/modules/user/user-assignable-rules";

/**
 * The vehicle's responsible person (plan of 02/11/2026, F1; decision D44):
 * a user of the vehicle's own company, who receives the failed-checklist
 * alert (F2). Null or absent leaves it to the company's admins.
 *
 * Another company's user answers exactly like one that does not exist —
 * same status, code and sentence (decision 11.3) — and, as every link named
 * in the vehicle form's body, it is a 400, like the driver and the branch.
 */
async function assertResponsibleUser(
  users: Pick<IUserRepository, "findUserById">,
  responsibleUserId: string | null | undefined,
  businessId: string,
): Promise<void> {
  if (!responsibleUserId) return;

  const user = await users.findUserById(responsibleUserId);

  if (!user || user.businessId !== businessId) {
    throw new UserResponsibleNotFoundError();
  }

  // They receive the failed-checklist alert, so they must still sign in.
  // The update calls this only for a person it changes to, so a vehicle
  // whose responsible later left keeps naming them until someone picks.
  assertAssignableUser(user);
}

export { assertResponsibleUser };
