import type { Prisma } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";

import type { IRouteRepository } from "../../repositories/IRoute-repository";

/**
 * Re-reads the driver's status inside the route write, under a shared row
 * lock (IRouteRepository.lockDriverStatus), and refuses anything but ACTIVE.
 *
 * The use cases check the status before their transaction for a good error
 * message; this closes the window between that read and the write, where a
 * deactivation (which holds the row FOR UPDATE while it counts open routes)
 * could commit and leave an inactive driver with a new route.
 *
 * A null status is a row that is not this company's: the checks before the
 * transaction already answered 404 for that, and the insert's foreign key
 * refuses a driver deleted in between.
 */
async function assertDriverStillActive(
  route: IRouteRepository,
  tx: Prisma.TransactionClient,
  {
    driverId,
    businessId,
    refusal,
  }: {
    driverId: string;
    businessId: string;
    refusal: { message: string; code: string };
  },
): Promise<void> {
  const status = await route.lockDriverStatus(driverId, businessId, tx);

  if (status !== null && status !== "ACTIVE") {
    throw new AppError(refusal.message, 400, refusal.code);
  }
}

export { assertDriverStillActive };
