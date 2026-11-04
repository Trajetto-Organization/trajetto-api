/**
 * The company's own settings (plan of 02/11/2026, item M1): what its admin
 * decides for the operation, as opposed to the plan the MASTER sells. Pure,
 * so the API, its tests and the payload builders agree on one set of rules.
 *
 * A company without a business_settings row reads the defaults, which are
 * the column defaults of migration 20261102120000 — the row only exists once
 * somebody saved. tests/E2E/schema-expand-contract.test.ts pins the two
 * together.
 */

type ChecklistRequirement =
  | "NONE"
  | "ROUTE_START"
  | "ROUTE_END"
  | "ROUTE_START_AND_END";

/**
 * What an action at the customer's address does when the phone is outside
 * the radius. It covers every action there — arrival, proof and occurrence
 * (the owner's call on D13). ALERT asks the driver to confirm and flags the
 * record; BLOCK refuses an arrival or a proof outside the radius, never an
 * occurrence (flagged instead).
 */
type GeofenceMode = "DISABLED" | "ALERT" | "BLOCK";

interface BusinessSettingsValues {
  checklist_requirement: ChecklistRequirement;
  /** Named after the arrival for history; it governs every action there. */
  arrival_geofence_mode: GeofenceMode;
  /** Metres. */
  arrival_geofence_radius_m: number;
}

const CHECKLIST_REQUIREMENTS: readonly ChecklistRequirement[] = [
  "NONE",
  "ROUTE_START",
  "ROUTE_END",
  "ROUTE_START_AND_END",
] as const;

const GEOFENCE_MODES: readonly GeofenceMode[] = [
  "DISABLED",
  "ALERT",
  "BLOCK",
] as const;

/**
 * The bounds of the radius (decision D12), also a CHECK in the database
 * (business_settings_geofence_radius_chk): a radius of a few metres would
 * block honest drivers on GPS noise, and one of tens of kilometres would be
 * no control at all.
 */
const GEOFENCE_RADIUS_MIN_M = 50;
const GEOFENCE_RADIUS_MAX_M = 5_000;

const BUSINESS_SETTINGS_DEFAULTS: BusinessSettingsValues = {
  checklist_requirement: "NONE",
  arrival_geofence_mode: "DISABLED",
  arrival_geofence_radius_m: 500,
};

/** The settings as stored, or the defaults for a company that never saved. */
function settingsOrDefaults(
  stored: Partial<BusinessSettingsValues> | null | undefined,
): BusinessSettingsValues {
  return {
    checklist_requirement:
      stored?.checklist_requirement ??
      BUSINESS_SETTINGS_DEFAULTS.checklist_requirement,
    arrival_geofence_mode:
      stored?.arrival_geofence_mode ??
      BUSINESS_SETTINGS_DEFAULTS.arrival_geofence_mode,
    arrival_geofence_radius_m:
      stored?.arrival_geofence_radius_m ??
      BUSINESS_SETTINGS_DEFAULTS.arrival_geofence_radius_m,
  };
}

/** Which settings apply, given the modules the company has on (item M6). */
interface SettingsAvailability {
  /** The checklist on the route needs the fleet AND the deliveries. */
  checklist: boolean;
  /** The geofence is about deliveries. */
  geofence: boolean;
}

function settingsAvailability(
  enabledModules: readonly string[],
): SettingsAvailability {
  const fleet = enabledModules.includes("FLEET");
  const deliveries = enabledModules.includes("DELIVERIES");

  return { checklist: fleet && deliveries, geofence: deliveries };
}

/**
 * What the driver's app and the API enforce (item M6): a setting whose
 * module is off reads as its neutral value, whatever was saved — the saved
 * value comes back untouched when the module is switched on again.
 */
function effectiveBusinessSettings(
  stored: Partial<BusinessSettingsValues> | null | undefined,
  enabledModules: readonly string[],
): BusinessSettingsValues {
  const settings = settingsOrDefaults(stored);
  const available = settingsAvailability(enabledModules);

  return {
    checklist_requirement: available.checklist
      ? settings.checklist_requirement
      : "NONE",
    arrival_geofence_mode: available.geofence
      ? settings.arrival_geofence_mode
      : "DISABLED",
    arrival_geofence_radius_m: settings.arrival_geofence_radius_m,
  };
}

/** The fields an update would actually change, with their two values. */
type SettingsChange = {
  [Key in keyof BusinessSettingsValues]: {
    field: Key;
    from: BusinessSettingsValues[Key];
    to: BusinessSettingsValues[Key];
  };
}[keyof BusinessSettingsValues];

function settingsChanges(
  before: BusinessSettingsValues,
  update: Partial<BusinessSettingsValues>,
): SettingsChange[] {
  const changes: SettingsChange[] = [];

  for (const field of Object.keys(
    BUSINESS_SETTINGS_DEFAULTS,
  ) as (keyof BusinessSettingsValues)[]) {
    const to = update[field];

    if (to !== undefined && to !== before[field]) {
      changes.push({ field, from: before[field], to } as SettingsChange);
    }
  }

  return changes;
}

const CHECKLIST_REQUIREMENT_LABELS: Record<ChecklistRequirement, string> = {
  NONE: "Não exigir",
  ROUTE_START: "No início da rota",
  ROUTE_END: "No fim da rota",
  ROUTE_START_AND_END: "No início e no fim da rota",
};

const GEOFENCE_MODE_LABELS: Record<GeofenceMode, string> = {
  DISABLED: "Desativado",
  ALERT: "Alertar",
  BLOCK: "Bloquear",
};

/** "Checklist da rota: Não exigir → No início da rota", for the audit trail. */
function describeSettingsChange(change: SettingsChange): string {
  switch (change.field) {
    case "checklist_requirement":
      return `Checklist da rota: ${CHECKLIST_REQUIREMENT_LABELS[change.from]} → ${CHECKLIST_REQUIREMENT_LABELS[change.to]}`;
    case "arrival_geofence_mode":
      return `Apontamento fora do raio do cliente: ${GEOFENCE_MODE_LABELS[change.from]} → ${GEOFENCE_MODE_LABELS[change.to]}`;
    case "arrival_geofence_radius_m":
      return `Raio limite para apontamento no cliente: ${change.from} m → ${change.to} m`;
  }
}

export {
  BUSINESS_SETTINGS_DEFAULTS,
  CHECKLIST_REQUIREMENTS,
  CHECKLIST_REQUIREMENT_LABELS,
  GEOFENCE_MODES,
  GEOFENCE_MODE_LABELS,
  GEOFENCE_RADIUS_MAX_M,
  GEOFENCE_RADIUS_MIN_M,
  describeSettingsChange,
  effectiveBusinessSettings,
  settingsAvailability,
  settingsChanges,
  settingsOrDefaults,
};
export type {
  BusinessSettingsValues,
  ChecklistRequirement,
  GeofenceMode,
  SettingsAvailability,
  SettingsChange,
};
