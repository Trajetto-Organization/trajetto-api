import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import type { CreateActivityProps } from "@/shared/services/notification-service";

/**
 * The person acting on a company's integrations, after checking they may.
 *
 * The routes already pass the tenant guard; this is the same check inside the
 * use case, so the rule holds for any caller (the unit tests among them).
 */
async function scopedBusiness(
  users: IUserRepository,
  userId: string,
  businessId: string,
): Promise<NonNullable<Awaited<ReturnType<IUserRepository["findUserById"]>>>> {
  const user = await users.findUserById(userId);

  // 404 USER_NOT_FOUND, like every other route (decision 11.3).
  if (!user) throw new ResourceNotFoundError();

  assertTenantAccess(user, businessId);

  return user;
}

/** Who writes the activity trail: the notification service, in production. */
interface ActivityRecorder {
  createActivityIfEnabled: (activity: CreateActivityProps) => Promise<void>;
}

/**
 * The audit trail for the credentials of an integration.
 *
 * Issuing a key hands a system standing access to a company's deliveries;
 * revoking one stops somebody's ERP; pointing a webhook somewhere sends every
 * event of the operation to an address a person chose. The secret never goes
 * in: a key is named by its prefix, which is what the screen shows.
 */
function audit(
  recorder: ActivityRecorder,
  entry: {
    action: "create" | "update" | "delete";
    entityId: string;
    description: string;
    status: string;
    performedBy: string;
    businessId: string;
  },
): void {
  // Not awaited, like every other call site: a revoke must not fail because
  // the trail could not be written.
  void recorder.createActivityIfEnabled({ type: "Integração", ...entry });
}

export { audit, scopedBusiness };
export type { ActivityRecorder };
