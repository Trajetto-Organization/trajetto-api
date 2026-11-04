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
 * What 0 means in the company's numeric limits — the one place that says it
 * (plan M2). The two limits that exist read it in OPPOSITE ways:
 *
 * | Business column     | 0 means                              | above 0                                          |
 * | ------------------- | ------------------------------------ | ------------------------------------------------ |
 * | `vehicle_limit`     | not configured: never blocks         | contracted fleet size, enforced on every slot    |
 * | `ai_analysis_limit` | AI switched off: no photo is read    | photos read per month, in the company's own zone |
 *
 * Kept on purpose. Making them agree would either switch the AI on for every
 * company that never bought it, or start refusing vehicles to companies whose
 * limit was never filled. Read a limit only through the predicates below,
 * never with an inline `> 0`, so the meaning cannot drift between screens.
 *
 * A NEW limit does not reuse zero: it is a nullable column where NULL means
 * unlimited and 0 means literally zero — never a third meaning for 0.
 */
const LIMIT_ZERO_MEANING = {
  vehicle_limit: "unlimited",
  ai_analysis_limit: "disabled",
} as const;

/** `vehicle_limit` > 0: the contracted fleet is enforced (0 = no limit). */
function isVehicleLimitEnforced(
  vehicleLimit: number | null | undefined,
): boolean {
  return (vehicleLimit ?? 0) > 0;
}

/** `ai_analysis_limit` > 0: the company reads photos with AI (0 = AI off). */
function isAIAnalysisEnabled(
  aiAnalysisLimit: number | null | undefined,
): boolean {
  return (aiAnalysisLimit ?? 0) > 0;
}

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
 * that predate the field keep working untouched (LIMIT_ZERO_MEANING).
 */
function canRegisterVehicle(
  activeCount: number,
  vehicleLimit: number,
): VehicleQuotaVerdict {
  if (!isVehicleLimitEnforced(vehicleLimit) || activeCount < vehicleLimit) {
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
  if (!isVehicleLimitEnforced(vehicleLimit) || activeCount < vehicleLimit) {
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

/**
 * The MASTER switched the module off: the row exists and is disabled.
 *
 * What pauses the company's webhooks with Entregas (plan M3, D51), and why a
 * missing row does not: a company that never hired the module could never
 * register an endpoint — the integration screens and the API key are gated
 * on it — so it has nothing to hold. The pause follows the switch.
 */
function isModuleSwitchedOff(
  rows: Array<{ module: string; enabled: boolean }>,
  module: string,
): boolean {
  return rows.some((row) => row.module === module && !row.enabled);
}

type MasterModuleRefusal =
  | "company-not-found"
  | "company-inactive"
  | "module-not-enabled";

/**
 * Why a MASTER request is refused by the module gate, or null to let it on.
 *
 * `requested` are the companies the request names; `companies` what the
 * database knows of them (an unknown id is absent). The most basic reason
 * wins: a company that does not exist, then one switched off, then the plan.
 * Answering MODULE_NOT_ENABLED for the first two made the web offer "Gerenciar
 * módulos" for a company nobody can operate. A switched-off company that
 * DID hire the module is not this gate's to refuse: the tenant gate of the
 * route answers for it, exactly as before.
 */
function masterModuleRefusal(
  requested: readonly string[],
  companies: ReadonlyArray<{
    id: string;
    isActive: boolean;
    moduleEnabled: boolean;
  }>,
): MasterModuleRefusal | null {
  const byId = new Map(companies.map((company) => [company.id, company]));
  const named = requested.map((id) => byId.get(id));

  if (named.some((company) => company === undefined)) {
    return "company-not-found";
  }

  const withoutModule = named.filter((company) => !company!.moduleEnabled);

  if (withoutModule.some((company) => !company!.isActive)) {
    return "company-inactive";
  }

  return withoutModule.length > 0 ? "module-not-enabled" : null;
}

export {
  LIMIT_ZERO_MEANING,
  canRegisterVehicle,
  canReactivateVehicle,
  isAIAnalysisEnabled,
  isVehicleLimitEnforced,
  occupiesFleetSlot,
  isModuleEnabled,
  isModuleSwitchedOff,
  masterModuleRefusal,
};
export type { MasterModuleRefusal, VehicleQuotaVerdict };
