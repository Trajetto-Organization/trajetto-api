import { AppError } from "@/shared/errors/AppError";

import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Whether a set of deliveries may be put on a route, given the rows that came
 * back for the ids the caller asked about.
 *
 * Pure, and shared by `create-route` and `add-route-stops` because they are the
 * same question asked at two moments. Two copies of it would drift the first
 * time one of them learned about a new delivery status.
 *
 * All-or-nothing, with the offenders named. A dispatcher who selected twelve
 * deliveries and got "uma delas não pode" would have to find which one by
 * bisecting the selection; what they need is the list.
 *
 * Two refusals: 404 for an id that is not a delivery OF THIS COMPANY — missing
 * and another company's answer the same, so nobody can probe which ids exist
 * (decision 11.3) — and 400 for one that is real and yours and simply not
 * available. Only the second is something the dispatcher can act on.
 */
function assertDeliveriesRoutable(
  deliveries: Delivery[],
  requestedIds: string[],
  businessId: string,
): void {
  if (
    deliveries.length !== requestedIds.length ||
    deliveries.some((entry) => entry.businessId !== businessId)
  ) {
    throw new AppError(
      "Uma das entregas não foi encontrada.",
      404,
      "DELIVERY_NOT_FOUND",
    );
  }

  // PENDING is the only routable state. A delivery already IN_TRANSIT is on
  // somebody's truck right now; one DELIVERED, FAILED or CANCELLED is history.
  const blocked = deliveries.filter((entry) => entry.status !== "PENDING");

  if (blocked.length > 0) {
    throw new AppError(
      "Só é possível montar rota com entregas pendentes: " +
        blocked.map((entry) => entry.code ?? entry.recipient_name).join(", "),
      400,
      "DELIVERY_NOT_ROUTABLE",
    );
  }
}

export { assertDeliveriesRoutable };
