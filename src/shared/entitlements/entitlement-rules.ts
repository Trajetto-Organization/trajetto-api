/**
 * Entitlement decision rules, kept pure so they can be unit-tested. The
 * lookups live in the entitlement service; the verdicts live here.
 */

interface VehicleQuotaVerdict {
  allowed: boolean;

  /** Present when blocked — the exact message the user should read. */
  reason: string | null;
}

type VehicleStatus = "ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE";

/**
 * A contracted slot is occupied by every vehicle that is part of the
 * operating fleet. Only INACTIVE frees the slot — that is the customer's
 * self-service lever when the plan shrinks: inactivate (history preserved),
 * never delete. BLOCKED and IN_ROUTE are temporary operational states and
 * still occupy their slot.
 */
function occupiesFleetSlot(status: VehicleStatus): boolean {
  return status !== "INACTIVE";
}

/**
 * Whether one more vehicle fits the contracted fleet size. `activeCount`
 * must already exclude INACTIVE vehicles (see occupiesFleetSlot).
 *
 * A limit of 0 means "not configured" and never blocks: enforcement is an
 * opt-in that starts when the master fills the field — existing companies
 * that predate the field keep working untouched.
 */
function canRegisterVehicle(
  activeCount: number,
  vehicleLimit: number,
): VehicleQuotaVerdict {
  if (vehicleLimit <= 0 || activeCount < vehicleLimit) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason:
      `Limite de veículos contratados atingido (${activeCount}/${vehicleLimit} ativos). ` +
      "Inative um veículo ou fale com o suporte para ampliar o plano da empresa.",
  };
}

/**
 * Reactivating an INACTIVE vehicle re-occupies a slot, so it passes the
 * same gate as a new registration — otherwise inactivate 14 + register 14
 * new + reactivate the old 14 would put 34 active vehicles on a 20 plan.
 */
function canReactivateVehicle(
  activeCount: number,
  vehicleLimit: number,
): VehicleQuotaVerdict {
  if (vehicleLimit <= 0 || activeCount < vehicleLimit) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason:
      `Limite de veículos contratados atingido (${activeCount}/${vehicleLimit} ativos). ` +
      "Para reativar este veículo, inative outro ou amplie o plano da empresa.",
  };
}

/**
 * A module row must exist AND be enabled — a missing row is "never hired",
 * a disabled row is "hired and switched off"; both deny.
 */
function isModuleEnabled(
  rows: Array<{ module: string; enabled: boolean }>,
  module: string,
): boolean {
  return rows.some((row) => row.module === module && row.enabled);
}

export {
  canRegisterVehicle,
  canReactivateVehicle,
  occupiesFleetSlot,
  isModuleEnabled,
};
export type { VehicleQuotaVerdict };
