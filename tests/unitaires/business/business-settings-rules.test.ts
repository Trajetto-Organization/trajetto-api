import { describe, expect, it } from "vitest";

import {
  BUSINESS_SETTINGS_DEFAULTS,
  describeSettingsChange,
  effectiveBusinessSettings,
  settingsAvailability,
  settingsChanges,
  settingsOrDefaults,
} from "@/shared/business/business-settings";
import { updateBusinessSettingsSchema } from "@/schemas/business-settings-schema";

/**
 * The rules of "Configurações da empresa" (plan of 02/11/2026, M1 and M6):
 * the defaults (the column defaults of migration 20261102120000, pinned to
 * the database by tests/E2E/schema-expand-contract.test.ts), the module
 * rule, what counts as a change, and the bounds of a save.
 */
describe("the company's settings", () => {
  it("reads a company that never saved as the defaults", () => {
    expect(settingsOrDefaults(null)).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
    });
    expect(BUSINESS_SETTINGS_DEFAULTS).toEqual(settingsOrDefaults(undefined));
  });

  it("applies the checklist only with the fleet and the deliveries, the geofence only with the deliveries", () => {
    expect(settingsAvailability(["FLEET", "DELIVERIES"])).toEqual({
      checklist: true,
      geofence: true,
    });
    expect(settingsAvailability(["DELIVERIES"])).toEqual({
      checklist: false,
      geofence: true,
    });
    expect(settingsAvailability(["FLEET"])).toEqual({
      checklist: false,
      geofence: false,
    });
    expect(settingsAvailability([])).toEqual({
      checklist: false,
      geofence: false,
    });
  });

  it("reads a setting whose module is off as its neutral value, keeping the saved one", () => {
    const saved = {
      checklist_requirement: "ROUTE_END" as const,
      arrival_geofence_mode: "BLOCK" as const,
      arrival_geofence_radius_m: 250,
    };

    expect(effectiveBusinessSettings(saved, ["FLEET", "DELIVERIES"])).toEqual(
      saved,
    );
    expect(effectiveBusinessSettings(saved, ["FLEET"])).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 250,
    });
    // The saved row itself is untouched: switching the module on again
    // brings the company's choice back.
    expect(saved.arrival_geofence_mode).toBe("BLOCK");
  });

  it("counts as a change only a field given with a different value", () => {
    const before = settingsOrDefaults(null);

    expect(
      settingsChanges(before, {
        checklist_requirement: "NONE",
        arrival_geofence_mode: undefined,
        arrival_geofence_radius_m: 800,
      }),
    ).toEqual([{ field: "arrival_geofence_radius_m", from: 500, to: 800 }]);

    expect(settingsChanges(before, {})).toEqual([]);
  });

  it("writes each change for the audit trail with the screen's own words", () => {
    expect(
      describeSettingsChange({
        field: "checklist_requirement",
        from: "NONE",
        to: "ROUTE_START",
      }),
    ).toBe("Checklist da rota: Não exigir → No início da rota");
    expect(
      describeSettingsChange({
        field: "arrival_geofence_mode",
        from: "ALERT",
        to: "BLOCK",
      }),
    ).toBe("Apontamento fora do raio do cliente: Alertar → Bloquear");
    expect(
      describeSettingsChange({
        field: "arrival_geofence_radius_m",
        from: 500,
        to: 1200,
      }),
    ).toBe("Raio limite para apontamento no cliente: 500 m → 1200 m");
  });
});

describe("a save of the company's settings", () => {
  it("accepts any one of the fields, within the radius bounds", () => {
    expect(
      updateBusinessSettingsSchema.safeParse({ arrival_geofence_radius_m: 50 })
        .success,
    ).toBe(true);
    expect(
      updateBusinessSettingsSchema.safeParse({
        arrival_geofence_radius_m: 5000,
      }).success,
    ).toBe(true);
    expect(
      updateBusinessSettingsSchema.safeParse({
        checklist_requirement: "ROUTE_START_AND_END",
        arrival_geofence_mode: "ALERT",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a radius below 50 m", { arrival_geofence_radius_m: 49 }],
    ["a radius above 5,000 m", { arrival_geofence_radius_m: 5001 }],
    ["a fractional radius", { arrival_geofence_radius_m: 120.5 }],
    ["an unknown mode", { arrival_geofence_mode: "WARN" }],
    ["an unknown requirement", { checklist_requirement: "ALWAYS" }],
    ["nothing to save", {}],
    // Decision 16.100: the company comes from the path, never the body.
    [
      "a company in the body",
      { arrival_geofence_mode: "ALERT", businessId: "outra-empresa" },
    ],
  ])("refuses %s", (_label, body) => {
    expect(updateBusinessSettingsSchema.safeParse(body).success).toBe(false);
  });
});
