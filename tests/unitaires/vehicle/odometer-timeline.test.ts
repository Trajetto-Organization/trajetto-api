import { describe, expect, it } from "vitest";

import {
  fitsOdometerTimeline,
  neighboursAmong,
  recordDate,
  type TimelineReading,
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

/**
 * The neighbours carry the record that holds each reading (05/11/2026): a
 * reading may equal one less than 30 minutes away (placeReading), so the
 * date of the record that holds it is part of the answer. The Postgres read
 * takes the top row of each kind and side; the twins hand every row of the
 * vehicle. Both choose here.
 */
describe("neighboursAmong", () => {
  const at = new Date("2026-11-05T14:00:00.000Z");
  const reading = (
    kind: TimelineReading["kind"],
    id: string,
    mileage: number,
    iso: string,
  ): TimelineReading => ({ kind, id, mileage, at: new Date(iso) });

  it("is the highest reading at or before the date and the lowest after it, with its record", () => {
    const neighbours = neighboursAmong(
      [
        reading("fuel", "yesterday", 49_000, "2026-11-04T14:00:00.000Z"),
        reading("checklist", "departure", 50_000, "2026-11-05T13:50:00.000Z"),
        // At the very date: before, as `lte` reads it.
        reading("fuel", "same-instant", 49_500, "2026-11-05T14:00:00.000Z"),
        reading("fuel", "afternoon", 50_400, "2026-11-05T16:00:00.000Z"),
        reading("checklist", "arrival", 50_300, "2026-11-05T15:00:00.000Z"),
      ],
      at,
    );

    expect(neighbours).toMatchObject({
      before: 50_000,
      after: 50_300,
      beforeReading: { kind: "checklist", id: "departure" },
      afterReading: { kind: "checklist", id: "arrival" },
    });
  });

  it("names the record nearest to the date when several hold the same km", () => {
    // Two tanks at the same stop before it, two readings at the same km
    // after it: the one minutes away is the one that counts.
    const neighbours = neighboursAmong(
      [
        reading("fuel", "first-tank", 50_000, "2026-11-05T13:20:00.000Z"),
        reading("fuel", "second-tank", 50_000, "2026-11-05T13:40:00.000Z"),
        reading("checklist", "late", 50_300, "2026-11-05T15:00:00.000Z"),
        reading("fuel", "soon", 50_300, "2026-11-05T14:20:00.000Z"),
      ],
      at,
    );

    expect(neighbours.beforeReading?.id).toBe("second-tank");
    expect(neighbours.afterReading?.id).toBe("soon");
  });

  it("is empty with nothing around, and skips a date that is not one", () => {
    expect(neighboursAmong([], at)).toEqual({
      before: null,
      after: null,
      beforeReading: null,
      afterReading: null,
    });
    expect(
      neighboursAmong([reading("fuel", "broken", 50_000, "not a date")], at)
        .before,
    ).toBeNull();
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

  it("says a bound may be repeated when its record is less than 30 minutes away", () => {
    // "Maior que 18.200" alone sent the office to type 18.201 for the second
    // tank of the same stop (05/11/2026).
    const record = {
      at: new Date("2026-11-05T14:10:00.000Z"),
      timeZone: "America/Sao_Paulo",
    };
    const around = (beforeIso: string, afterIso: string) => ({
      neighbours: {
        before: 18_200,
        after: 18_600,
        beforeReading: {
          kind: "fuel" as const,
          id: "first-tank",
          mileage: 18_200,
          at: new Date(beforeIso),
        },
        afterReading: {
          kind: "checklist" as const,
          id: "arrival",
          mileage: 18_600,
          at: new Date(afterIso),
        },
      },
      laterDay: 18_600,
    });

    const near = editedReadingRefusal(
      true,
      around("2026-11-05T14:00:00.000Z", "2026-11-05T14:20:00.000Z"),
      record,
    );

    expect(near.message).toContain("entre 18.200 km e 18.600 km");
    expect(near.message).toContain(
      "Também pode ser igual a 18.200 km ou 18.600 km, de um registro com menos de 30 minutos de diferença.",
    );

    const oneSide = editedReadingRefusal(
      true,
      around("2026-11-05T14:00:00.000Z", "2026-11-05T18:00:00.000Z"),
      record,
    );

    expect(oneSide.message).toContain(
      "Também pode ser igual a 18.200 km, de um registro",
    );
    expect(oneSide.message).not.toContain("18.600 km, de um registro");

    // An hour away, or without the record's date: the strict sentence.
    for (const strict of [
      editedReadingRefusal(
        true,
        around("2026-11-05T13:00:00.000Z", "2026-11-05T18:00:00.000Z"),
        record,
      ),
      editedReadingRefusal(
        true,
        around("2026-11-05T14:00:00.000Z", "2026-11-05T14:20:00.000Z"),
      ),
    ]) {
      expect(strict.message).not.toContain("Também pode ser igual");
    }
  });

  it("tells the create's refusal that the same km is fine minutes apart", () => {
    // VEHICLE_MILEAGE_INVALID: "maior que" alone stopped being the rule. The
    // web sends only the day, which never stands still: the sentence says so.
    expect(new VehicleMileageInvalidError().message).toBe(
      "A quilometragem informada deve ser maior que a quilometragem atual do veículo, ou igual à de outro registro com menos de 30 minutos de diferença, os dois com hora (não só o dia)!",
    );
  });
});
