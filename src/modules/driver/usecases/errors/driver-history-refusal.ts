import type { AppError } from "@/shared/errors/AppError";

import { DriverHasAssociatedUserError } from "./driver-has-associated-user-error";
import { DriverHasAssociatedFinesError } from "./driver-has-associated-fines-error";
import { DriverHasAssociatedFuelError } from "./driver-has-associated-fuel-error";
import { DriverHasAssociatedChecklistsError } from "./driver-has-associated-checklists-error";
import { DriverHasAssociatedOperationError } from "./driver-has-associated-operation-error";
import { DriverHasAssociatedPausesError } from "./driver-has-associated-pauses-error";

/**
 * Rows that still point at a driver and keep them from being deleted: an app
 * account, fines, fuelings, checklists, deliveries, routes and pauses. Each
 * is either a RESTRICT key (the delete would fail) or an optional one the
 * delete would silently set to NULL (whose work it was is lost).
 */
interface DriverHistoryCounts {
  users: number;
  fines: number;
  fuels: number;
  checklists: number;
  deliveries: number;
  routes: number;
  pauses: number;
}

const NO_DRIVER_HISTORY: DriverHistoryCounts = {
  users: 0,
  fines: 0,
  fuels: 0,
  checklists: 0,
  deliveries: 0,
  routes: 0,
  pauses: 0,
};

/**
 * The refusal for the first kind of history found, in the order the delete
 * dialog lists them, or null when the driver has none. The use case asks it
 * before deleting, and the repository asks it again under the driver row's
 * lock, so both answers are the same 409.
 */
function driverHistoryRefusal(counts: DriverHistoryCounts): AppError | null {
  if (counts.users > 0) return new DriverHasAssociatedUserError();

  if (counts.fines > 0) return new DriverHasAssociatedFinesError(counts.fines);

  if (counts.fuels > 0) return new DriverHasAssociatedFuelError(counts.fuels);

  if (counts.checklists > 0) {
    return new DriverHasAssociatedChecklistsError(counts.checklists);
  }

  if (counts.deliveries > 0 || counts.routes > 0) {
    return new DriverHasAssociatedOperationError(
      counts.deliveries,
      counts.routes,
    );
  }

  if (counts.pauses > 0)
    return new DriverHasAssociatedPausesError(counts.pauses);

  return null;
}

export { driverHistoryRefusal, NO_DRIVER_HISTORY, type DriverHistoryCounts };
