import type { VehicleStatusCounts } from "@/modules/vehicle/dtos/vehicle-dto";

/**
 * The four states a vehicle can be in. Listed here as the single source both
 * repositories tally against, so a status added to the enum without a decision
 * about the cards fails to compile rather than silently vanishing from them.
 */
const VEHICLE_STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"] as const;

type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/**
 * Turns a grouped count into the full tally.
 *
 * A group only exists for a status that has at least one row, so the zeros
 * have to be filled in — otherwise a fleet with nothing blocked would send no
 * `BLOCKED` key at all and the card would read `undefined`, not 0.
 *
 * Counting is deliberately NOT done over the page of rows the listing returns:
 * that is what the vehicle page used to do, and it reported ten rows as if
 * they were the whole fleet — "10 (25%)" on a fleet of forty, changing every
 * time the user paged.
 */
function tallyStatuses(
  groups: Array<{ status: VehicleStatus; _count: { _all: number } }>,
): VehicleStatusCounts {
  const counts = { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 };

  for (const group of groups) {
    counts[group.status] = group._count._all;
  }

  return counts;
}

/**
 * The fleet size is the sum of its four states, by definition. Deriving it
 * this way instead of running a second count() means the total on the pager
 * and the four cards are the same measurement, so they cannot disagree — and
 * it is one query, not two, over the same rows.
 */
function totalFromStatusCounts(counts: VehicleStatusCounts): number {
  return VEHICLE_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

/**
 * A vehicle that is out of operation cannot take new cargo. INACTIVE and
 * BLOCKED are lumped together for this decision even though they mean
 * different things for billing — see occupiesFleetSlot in entitlement-rules,
 * where only INACTIVE frees a contracted slot.
 *
 * IN_ROUTE is deliberately NOT unavailable: tomorrow's load is dispatched
 * while today's route is still on the street.
 */
function isVehicleOutOfOperation(status: VehicleStatus): boolean {
  return status === "INACTIVE" || status === "BLOCKED";
}

export {
  VEHICLE_STATUSES,
  tallyStatuses,
  totalFromStatusCounts,
  isVehicleOutOfOperation,
};
export type { VehicleStatus };
