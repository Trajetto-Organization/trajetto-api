import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";

/**
 * The company whose operation a manager surface reads (tower, trail, both
 * monitoring boards), after the checks every one of them makes.
 *
 * A driver token is refused rather than shown everybody's day: the app's
 * permission table opens delivery_manage for the driver's own work, and
 * these screens are the whole fleet. A MASTER names the company; anyone else
 * reads their own, and naming another one is a tenant refusal.
 */
async function resolveOperationsBusiness(
  users: IUserRepository,
  {
    userId,
    businessId,
    driverRefusal,
  }: { userId: string; businessId?: string; driverRefusal: string },
): Promise<string> {
  const findUser = await users.findUserById(userId);

  if (!findUser) {
    throw new ResourceNotFoundError();
  }

  if (findUser.driverId) {
    throw new AppError(driverRefusal, 403, "DRIVER_CANNOT_VIEW_PANELS");
  }

  const resolvedBusinessId = businessId ?? findUser.businessId;

  if (!resolvedBusinessId) {
    throw new AppError(
      "Empresa não identificada. Selecione uma empresa para continuar.",
      400,
      "BUSINESS_NOT_IDENTIFIED",
    );
  }

  assertTenantAccess(findUser, resolvedBusinessId);

  return resolvedBusinessId;
}

const TOWER_DRIVER_REFUSAL = "A torre de controle é superfície do gestor.";
const PANEL_DRIVER_REFUSAL =
  "Painéis de monitoramento são superfície do gestor.";

export {
  PANEL_DRIVER_REFUSAL,
  TOWER_DRIVER_REFUSAL,
  resolveOperationsBusiness,
};
