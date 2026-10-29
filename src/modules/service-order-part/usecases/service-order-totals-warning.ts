import type { ServiceOrderTotals } from "../dtos/service-order-part-dto";

/**
 * What a part change answers about its order's money (FLEET-SO-2).
 *
 * The order's total is typed — labour plus parts, as the workshop billed it —
 * and is not recalculated from the lines. The one inconsistency the system
 * can tell for sure is parts alone costing more than the whole order; the
 * screen shows it as a warning, never a refusal.
 */
function totalsWarning(totals: ServiceOrderTotals | null): {
  totals?: ServiceOrderTotals;
  partsExceedTotal?: boolean;
} {
  if (!totals) return {};

  return {
    totals,
    // Half a cent of slack: both figures are rounded to cents.
    partsExceedTotal: totals.partsTotal > totals.totalAmount + 0.005,
  };
}

export { totalsWarning };
