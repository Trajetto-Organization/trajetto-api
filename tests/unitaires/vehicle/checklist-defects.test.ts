import { describe, expect, it } from "vitest";

import { checklistDefects } from "@/shared/vehicle/checklist-defects";

/**
 * What makes a checklist worth an alert (plan of 02/11/2026, F2): only a
 * defect. A clean inspection happens daily per truck and must stay silent;
 * a failed item or a failed verdict must reach the fleet's responsible.
 * The items are the ones the app (features/checklist/checklist-rules.ts:
 * PHOTO_WHEN_FALSE_FIELDS, PHOTO_WHEN_NOT_GOOD_FIELDS) and the API
 * (PhotoValidationService "if_not_ok") already treat as a defect that needs
 * a photo, plus the tyres, which are photographed every time but are a
 * defect all the same when not good.
 */
const CLEAN = {
  headlights_working: true,
  taillights_working: true,
  turn_signals_working: true,
  seatbelts_working: true,
  dashboard_working: true,
  brakes_working: true,
  clutch_working: true,
  fuel_level_adequate: true,
  oil_level_adequate: true,
  radiator_water_adequate: true,
  brake_fluid_adequate: true,
  driver_license_valid: true,
  vehicle_documents_valid: true,
  insurance_valid: true,
  fire_extinguisher_valid: true,
  warning_triangle_present: true,
  jack_present: true,
  tires_condition: "good",
  bumpers_condition: "good",
  windshield_condition: "good",
  mirrors_condition: "good",
  steering_wheel_condition: "good",
  battery_condition: "good",
  spare_tire_condition: "good",
  overall_condition: "approved",
};

describe("checklistDefects", () => {
  it("finds nothing on a clean, approved checklist", () => {
    expect(checklistDefects(CLEAN)).toEqual({ items: [], verdict: null });
  });

  it("names a failed yes/no item and a graded item short of good", () => {
    expect(
      checklistDefects({
        ...CLEAN,
        brakes_working: false,
        battery_condition: "needs_attention",
        tires_condition: "bad",
      }),
    ).toEqual({
      items: ["Freios", "Pneus", "Bateria"],
      verdict: null,
    });
  });

  it("counts a failed or restricted verdict even with every item fine", () => {
    expect(
      checklistDefects({ ...CLEAN, overall_condition: "rejected" }),
    ).toEqual({ items: [], verdict: "Reprovado" });
    expect(
      checklistDefects({
        ...CLEAN,
        overall_condition: "approved_with_restrictions",
      }),
    ).toEqual({ items: [], verdict: "Aprovado com restrições" });
  });

  it("does not call low fuel or a document a vehicle defect", () => {
    expect(
      checklistDefects({
        ...CLEAN,
        fuel_level_adequate: false,
        driver_license_valid: false,
        insurance_valid: false,
      }),
    ).toEqual({ items: [], verdict: null });
  });

  it("ignores an item that was not answered", () => {
    const { brakes_working: _brakes, ...partial } = CLEAN;

    expect(checklistDefects(partial)).toEqual({ items: [], verdict: null });
  });
});
