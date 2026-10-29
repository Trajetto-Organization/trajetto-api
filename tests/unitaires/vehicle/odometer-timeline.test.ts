import { describe, expect, it } from "vitest";

import {
  fitsOdometerTimeline,
  recordDate,
} from "@/shared/vehicle/odometer-timeline";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import {
  VehicleMileageOutOfOrderError,
  editedReadingRefusal,
} from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";

/**
 * The second question a refused reading gets (GAP5-10): does it fit the
 * vehicle's history at its own date? Only asked after "more than the current
 * mileage" said no, so every case here is a reading at or below the vehicle's
 * odometer.
 */
describe("fitsOdometerTimeline", () => {
  it("accepts a reading strictly between the records around its date", () => {
    expect(fitsOdometerTimeline(10_000, { before: 9_800, after: 10_300 })).toBe(
      true,
    );
  });

  it("refuses a reading with no record before it: nothing bounds it from below", () => {
    // The floor there is the mileage the vehicle was registered with, which
    // no fueling or checklist carries — 9 000 on a vehicle registered at
    // 50 000 would be accepted, a typo or a fake the old rule refused.
    expect(fitsOdometerTimeline(9_000, { before: null, after: 10_300 })).toBe(
      false,
    );
  });

  it("refuses a reading with nothing after it: that record is the newest", () => {
    expect(fitsOdometerTimeline(10_000, { before: 9_800, after: null })).toBe(
      false,
    );
    expect(fitsOdometerTimeline(10_000, { before: null, after: null })).toBe(
      false,
    );
  });

  it("keeps the rule strict on both sides, as it is along arrival", () => {
    // Equal to the record before it: the odometer did not move.
    expect(fitsOdometerTimeline(9_800, { before: 9_800, after: 10_300 })).toBe(
      false,
    );

    // Equal to the record after it: in arrival order, that record would have
    // been the one refused.
    expect(fitsOdometerTimeline(10_300, { before: 9_800, after: 10_300 })).toBe(
      false,
    );
  });

  it("refuses a reading outside its neighbours", () => {
    expect(fitsOdometerTimeline(9_700, { before: 9_800, after: 10_300 })).toBe(
      false,
    );
    expect(fitsOdometerTimeline(10_400, { before: 9_800, after: 10_300 })).toBe(
      false,
    );
  });
});

describe("recordDate", () => {
  it("reads the date the record carries, or now when it carries none", () => {
    expect(recordDate("2026-09-20T12:00:00.000Z").toISOString()).toBe(
      "2026-09-20T12:00:00.000Z",
    );

    const before = Date.now();
    const now = recordDate(undefined).getTime();

    expect(now).toBeGreaterThanOrEqual(before);
  });
});

/**
 * The refusal an edit gets when placeReading (the one rule for fuelings and
 * checklists) turns it down. The checklist edit answered every refusal with
 * "must be greater than the vehicle's current mileage", also to someone who
 * had only moved the date.
 */
describe("editedReadingRefusal", () => {
  const later = (before: number | null, after: number | null) => ({
    neighbours: { before, after },
    laterDay: after,
  });

  it("names the bounds a record on its own vehicle left", () => {
    const both = editedReadingRefusal(true, later(17_000, 18_200));

    expect(both).toBeInstanceOf(VehicleMileageOutOfOrderError);
    // Still the plain refusal to every handler that catches that one.
    expect(both).toBeInstanceOf(VehicleMileageInvalidError);
    expect(both.message).toContain("entre 17.000 km e 18.200 km");

    expect(editedReadingRefusal(true, later(18_200, null)).message).toContain(
      "maior que 18.200 km",
    );
    expect(editedReadingRefusal(true, later(null, 17_000)).message).toContain(
      "menor que 17.000 km",
    );
  });

  it("does not hold it under a reading of its own civil day with none on a later one", () => {
    // placeReading lets such a record pass that reading: the web dates it at
    // local midnight, the app at the moment itself.
    const sameDay = editedReadingRefusal(true, {
      neighbours: { before: 18_200, after: 18_600 },
      laterDay: null,
    });

    expect(sameDay.message).toContain("maior que 18.200 km");
    expect(sameDay.message).not.toContain("18.600");
  });

  it("keeps the create's sentence for a record moved to another vehicle", () => {
    const moved = editedReadingRefusal(false, later(18_200, null));

    expect(moved).not.toBeInstanceOf(VehicleMileageOutOfOrderError);
    expect(moved.message).toBe(new VehicleMileageInvalidError().message);
  });
});
