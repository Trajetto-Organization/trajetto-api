import type { AppError } from "@/shared/errors/AppError";

import { DriverHasAssociatedUserError } from "./driver-has-associated-user-error";
import { DriverHasAssociatedFinesError } from "./driver-has-associated-fines-error";
import { DriverHasAssociatedFuelError } from "./driver-has-associated-fuel-error";
import { DriverHasAssociatedChecklistsError } from "./driver-has-associated-checklists-error";
import { DriverHasAssociatedOperationError } from "./driver-has-associated-operation-error";
import { DriverHasAssociatedPausesError } from "./driver-has-associated-pauses-error";

/**
 * Rows that still point at a driver and keep them from being deleted: an app
 * account, fines, fuelings, checklists, deliveries, routes, pauses and the
 * conversation (chat messages and support tickets). Each is either a
 * RESTRICT key (the delete would fail), an optional one the delete would
 * silently set to NULL (whose work it was is lost) or, for the conversation,
 * a CASCADE through the chat thread that erased it without a word (decision
 * D-39, 14/11/2026).
 */
interface DriverHistoryCounts {
  users: number;
  fines: number;
  fuels: number;
  checklists: number;
  deliveries: number;
  routes: number;
  pauses: number;
  /** Messages in the driver's chat thread, whoever sent them. */
  chatMessages: number;
  /** Support tickets opened on the driver's thread. */
  supportTickets: number;
}

const NO_DRIVER_HISTORY: DriverHistoryCounts = {
  users: 0,
  fines: 0,
  fuels: 0,
  checklists: 0,
  deliveries: 0,
  routes: 0,
  pauses: 0,
  chatMessages: 0,
  supportTickets: 0,
};

/**
 * The refusal for the first kind of history found, or null when the driver
 * has none. The use case asks it before deleting, and the repository asks it
 * again under the driver row's lock, so both answers are the same 409.
 *
 * The work comes first and the app account last (batch of 14/11/2026). With
 * the account first, a driver who had worked heard "remove the login", then
 * the login refused with USER_HAS_RECORDS ("revoke"), and only the third try
 * said the right thing: deactivate — which also locks the login out. The
 * account alone is the one case where deleting is right: a driver registered
 * by mistake whose login never did anything.
 */
function driverHistoryRefusal(counts: DriverHistoryCounts): AppError | null {
  if (counts.fines > 0) return new DriverHasAssociatedFinesError(counts.fines);

  if (counts.fuels > 0) return new DriverHasAssociatedFuelError(counts.fuels);

  if (counts.checklists > 0) {
    return new DriverHasAssociatedChecklistsError(counts.checklists);
  }

  if (
    counts.deliveries > 0 ||
    counts.routes > 0 ||
    counts.chatMessages > 0 ||
    counts.supportTickets > 0
  ) {
    return new DriverHasAssociatedOperationError(
      counts.deliveries,
      counts.routes,
      counts.chatMessages,
      counts.supportTickets,
    );
  }

  if (counts.pauses > 0)
    return new DriverHasAssociatedPausesError(counts.pauses);

  if (counts.users > 0) return new DriverHasAssociatedUserError();

  return null;
}

export { driverHistoryRefusal, NO_DRIVER_HISTORY, type DriverHistoryCounts };
