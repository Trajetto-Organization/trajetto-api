import "reflect-metadata";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_REFUEL_WINDOW_MINUTES,
  SAME_READING_WINDOW_MINUTES,
  businessTimeZone,
  changedLinks,
  endOfBusinessDay,
  isRefuelingInTheFuture,
  placeReading,
  releasedOdometer,
  standsStillWith,
  type ReadingOnTimeline,
} from "@/modules/fuel/usecases/fuel-rules";
import type { TimelineReading } from "@/shared/vehicle/odometer-timeline";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { createFuelSchema } from "@/schemas/create-fuel-schema";

/**
 * "Not in the future" is the company's calendar (decision 1.2).
 *
 * The schemas compared with the server's end of day — `setHours(23, 59, 59,
 * 999)` on a UTC container — so from 21:00 in São Paulo the next day passed
 * as today. The clock below is 22:30 in São Paulo (01:30 UTC, already the
 * next day for the server).
 */
const NIGHT_IN_SP = new Date("2026-09-28T01:30:00.000Z");

// Local midnight of the 28th in São Paulo: what the web's date picker sends
// for "tomorrow" when it is still the 27th there.
const TOMORROW_IN_SP = "2026-09-28T03:00:00.000Z";

// The app sends the moment of the fueling.
const JUST_NOW = "2026-09-28T01:29:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("isRefuelingInTheFuture", () => {
  it("reads the company's day, not the server's", () => {
    expect(
      isRefuelingInTheFuture(TOMORROW_IN_SP, "America/Sao_Paulo", NIGHT_IN_SP),
    ).toBe(true);

    expect(
      isRefuelingInTheFuture(JUST_NOW, "America/Sao_Paulo", NIGHT_IN_SP),
    ).toBe(false);
  });

  it("depends on the zone: 21:30 in Manaus is still the same day at 01:30 UTC", () => {
    // 2026-09-28T01:30Z is 21:30 of the 27th in Manaus (UTC-4); the picker's
    // midnight of the 27th there is 04:00Z of the 27th.
    expect(
      isRefuelingInTheFuture(
        "2026-09-27T04:00:00.000Z",
        "America/Manaus",
        NIGHT_IN_SP,
      ),
    ).toBe(false);

    expect(
      isRefuelingInTheFuture(
        "2026-09-28T04:00:00.000Z",
        "America/Manaus",
        NIGHT_IN_SP,
      ),
    ).toBe(true);
  });

  /**
   * A bare "YYYY-MM-DD" is stored as 00:00 UTC, the evening before in every
   * Brazilian zone. Read as an instant, tomorrow's date-only value was
   * "today, 21:00" and passed, then showed as tomorrow (the checklist's rule:
   * shared/vehicle/record-dates pickedDayKey).
   */
  it("reads a date-only value as the day it names", () => {
    // 22:30 of the 27th in São Paulo: the 28th is tomorrow.
    expect(
      isRefuelingInTheFuture(
        "2026-09-28T00:00:00.000Z",
        "America/Sao_Paulo",
        NIGHT_IN_SP,
      ),
    ).toBe(true);

    expect(
      isRefuelingInTheFuture(
        "2026-09-27T00:00:00.000Z",
        "America/Sao_Paulo",
        NIGHT_IN_SP,
      ),
    ).toBe(false);
  });

  it("falls back to São Paulo for a business row without a zone", () => {
    expect(businessTimeZone({ id: "x" })).toBe("America/Sao_Paulo");
    expect(businessTimeZone({ timezone: "America/Manaus" })).toBe(
      "America/Manaus",
    );
    expect(businessTimeZone(null)).toBe("America/Sao_Paulo");
  });
});

describe("the create schema no longer decides the day", () => {
  it("accepts any valid date; the use case applies the company's calendar", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT_IN_SP);

    const parsed = createFuelSchema.safeParse({
      current_mileage: 1000,
      liters_amount: 10,
      price_per_liter: 5,
      refueling_date: TOMORROW_IN_SP,
      vehicleId: "018fe600-0000-7000-8000-0000000000c1",
      fuelTypeId: "018fe600-0000-7000-8000-0000000000e1",
      created_from: "WEB_DASHBOARD",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("CreateFuelUseCase refuses a fueling dated after the company's today", () => {
  const BUSINESS = "018fe600-0000-7000-8000-00000000000a";

  function useCase(timezone: string) {
    const stub =
      <T>(value: T) =>
      async () =>
        value;
    const createFuelWithMileage = vi.fn(async () => ({
      fuel: { id: "f1", driverId: "d1", odometer_photo: null },
      created: true,
    }));

    const instance = new CreateFuelUseCase(
      {
        findUserById: stub({
          id: "admin",
          role: "BUSINESS_ADMIN",
          businessId: BUSINESS,
          driverId: null,
        }),
      } as never,
      {
        findBusinessById: stub({
          id: BUSINESS,
          ai_analysis_limit: 0,
          timezone,
        }),
      } as never,
      {
        findVehicleById: stub({
          id: "v1",
          businessId: BUSINESS,
          driverId: null,
          status: "ACTIVE",
          current_mileage: 100,
          fuelTypeId: "ft",
          branchId: "b1",
          license_plate: "ABC1D23",
          description: "Caminhão",
        }),
      } as never,
      {
        findDriverById: stub({
          id: "d1",
          businessId: BUSINESS,
          status: "ACTIVE",
          branchId: "b1",
        }),
      } as never,
      { findFuelTypeById: stub({ id: "ft", businessId: BUSINESS }) } as never,
      {
        findBranchById: stub({
          id: "b1",
          businessId: BUSINESS,
          is_active: true,
        }),
      } as never,
      { findBySubmissionId: stub(null), createFuelWithMileage } as never,
      { publish: vi.fn() } as never,
      {
        resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
          photos.map((photo) => ({ path: photo.key })),
        deleteFile: vi.fn(),
      } as never,
    );

    return { instance, createFuelWithMileage };
  }

  const fueling = (refueling_date: string) =>
    ({
      businessId: BUSINESS,
      vehicleId: "v1",
      driverId: "d1",
      fuelTypeId: "ft",
      branchId: "b1",
      current_mileage: 200,
      liters_amount: 10,
      price_per_liter: 5,
      refueling_date,
      created_from: "WEB_DASHBOARD",
    }) as never;

  it("at 22:30 in São Paulo, tomorrow is refused and nothing is written", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT_IN_SP);

    const { instance, createFuelWithMileage } = useCase("America/Sao_Paulo");

    await expect(
      instance.execute(fueling(TOMORROW_IN_SP), "admin", { key: "k" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "REFUELING_DATE_IN_FUTURE",
    });

    expect(createFuelWithMileage).not.toHaveBeenCalled();
  });

  /**
   * Decision 11.3: every refusal has a code. A pin moved by hand more than
   * 500 m from the GPS reading went out with no code (BAD_REQUEST), while the
   * service order already answered LOCATION_ADJUSTMENT_TOO_FAR.
   */
  it("refuses a pin moved more than 500 m from the GPS reading with its code", async () => {
    const { instance, createFuelWithMileage } = useCase("America/Sao_Paulo");

    await expect(
      instance.execute(
        {
          ...(fueling(new Date().toISOString()) as object),
          created_from: "MOBILE_APP",
          // An app refuelling carries its key (appSubmissionKeyRefusal).
          client_submission_id: "018fe600-0000-7000-8000-0000000000f1",
          location_source: "GPS_MANUAL",
          // About 1.1 km apart: one hundredth of a degree of latitude.
          latitude_original: -23.55,
          longitude_original: -46.63,
          latitude: -23.56,
          longitude: -46.63,
        } as never,
        "admin",
        { key: "k" },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "LOCATION_ADJUSTMENT_TOO_FAR",
    });

    expect(createFuelWithMileage).not.toHaveBeenCalled();
  });

  it("a fueling of right now goes through", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT_IN_SP);

    const { instance, createFuelWithMileage } = useCase("America/Sao_Paulo");

    await instance.execute(fueling(JUST_NOW), "admin", { key: "k" });

    expect(createFuelWithMileage).toHaveBeenCalledTimes(1);
  });
});

describe("changedLinks", () => {
  const current = {
    vehicleId: "v1",
    driverId: "d1",
    branchId: "b1",
    fuelTypeId: "f1",
  };

  it("sees only links the edit re-points", () => {
    expect(changedLinks(current, {})).toEqual({
      vehicle: false,
      driver: false,
      branch: false,
      fuelType: false,
    });

    expect(changedLinks(current, { vehicleId: "v1", driverId: "d2" })).toEqual({
      vehicle: false,
      driver: true,
      branch: false,
      fuelType: false,
    });
  });
});

/**
 * Where a refueling's km may go (FLEET-FUEL-1), for a create, an edit and a
 * move: by its date first, with the civil day of a web date and the odometer
 * that follows the refueling that set it. The checklist edit uses it too.
 *
 * Timeline of the reviewer's truck: 40.000 (10 days ago) · 45.500 (5 days
 * ago) · 48.000 (2 days ago), odometer 50.000 from its registration.
 */
describe("placeReading", () => {
  const middle = { before: 40_000, after: 48_000 };
  const newest = { before: 45_500, after: null };

  // Nothing after it on its own day, it set nothing, no maintenance. A
  // moment, but neighbours without their records: the strict rule.
  const plain = {
    laterDay: null as number | null,
    highest: 48_000 as number | null,
    maintenanceFloor: null as number | null,
    at: new Date("2026-09-28T14:10:00.000Z"),
    timeZone: "America/Sao_Paulo",
  };

  it("keeps a past refueling between its neighbours and leaves the vehicle", () => {
    expect(
      placeReading({
        ...plain,
        laterDay: 48_000,
        mileage: 44_500,
        neighbours: middle,
        odometer: 50_000,
        previousMileage: 45_500,
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("refuses a back-dated NEW refueling above the next day's reading, even ahead of the odometer", () => {
    // The old create ran the forward rule first, so 510.000 dated 4 days
    // ago moved the odometer past the 48.000 of 2 days ago (the E2E
    // fuel-historical-edit proves the create now goes through this rule).
    expect(
      placeReading({
        ...plain,
        laterDay: 48_000,
        mileage: 510_000,
        neighbours: { before: 45_500, after: 48_000 },
        odometer: 50_000,
        previousMileage: null,
      }),
    ).toEqual({ fits: false });

    // Between them it is a late record, and the vehicle stays.
    expect(
      placeReading({
        ...plain,
        laterDay: 48_000,
        mileage: 46_000,
        neighbours: { before: 45_500, after: 48_000 },
        odometer: 50_000,
        previousMileage: null,
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("lets today's web refueling pass readings of the same day, as the forward rule did", () => {
    // Web date = local midnight; the app's 07:00 checklist (50.100) is
    // "after" it but on the same day, and nothing is on a later day.
    const today = { before: 49_900, after: 50_100 };

    expect(
      placeReading({
        ...plain,
        mileage: 50_300,
        neighbours: today,
        laterDay: null,
        odometer: 50_100,
        previousMileage: null,
      }),
    ).toEqual({ fits: true, odometer: 50_300 });

    // Not ahead of the odometer, not between: refused as before.
    expect(
      placeReading({
        ...plain,
        mileage: 50_100,
        neighbours: today,
        laterDay: null,
        odometer: 50_100,
        previousMileage: null,
      }),
    ).toEqual({ fits: false });

    // The same reading with a later day after it is bounded by it.
    expect(
      placeReading({
        ...plain,
        mileage: 50_300,
        neighbours: today,
        laterDay: 50_200,
        odometer: 50_200,
        previousMileage: null,
      }),
    ).toEqual({ fits: false });
  });

  it("refuses a past refueling above the next reading, even above the odometer", () => {
    for (const mileage of [48_500, 51_000]) {
      expect(
        placeReading({
          ...plain,
          laterDay: 48_000,
          mileage,
          neighbours: middle,
          odometer: 50_000,
          previousMileage: 45_500,
        }),
      ).toEqual({ fits: false });
    }
  });

  it("moves the odometer forward for the newest reading ahead of it", () => {
    expect(
      placeReading({
        ...plain,
        highest: 45_500,
        mileage: 51_000,
        neighbours: newest,
        odometer: 50_000,
        previousMileage: 48_000,
      }),
    ).toEqual({ fits: true, odometer: 51_000 });
  });

  it("brings the odometer down with the newest refueling that set it, never below the last maintenance", () => {
    expect(
      placeReading({
        ...plain,
        highest: 14_000,
        mileage: 15_000,
        neighbours: { before: 14_000, after: null },
        odometer: 150_000,
        previousMileage: 150_000,
      }),
    ).toEqual({ fits: true, odometer: 15_000 });

    expect(
      placeReading({
        ...plain,
        highest: 14_000,
        maintenanceFloor: 15_500,
        mileage: 15_000,
        neighbours: { before: 14_000, after: null },
        odometer: 150_000,
        previousMileage: 150_000,
      }),
    ).toEqual({ fits: true, odometer: 15_500 });
  });

  it("releases an odometer a past refueling set, when corrected between later readings", () => {
    // Red on the old rule (odometer null): the 510.000 of 4 days ago,
    // corrected to 46.000, left the odometer at 510.000 for good.
    expect(
      placeReading({
        ...plain,
        laterDay: 48_000,
        highest: 48_000,
        mileage: 46_000,
        neighbours: { before: 45_500, after: 48_000 },
        odometer: 510_000,
        previousMileage: 510_000,
      }),
    ).toEqual({ fits: true, odometer: 48_000 });
  });

  it("releases to the highest reading of the day for a web refueling that set it", () => {
    expect(
      placeReading({
        ...plain,
        laterDay: null,
        highest: 50_280,
        mileage: 50_250,
        neighbours: { before: 49_900, after: 50_100 },
        odometer: 50_300,
        previousMileage: 50_300,
      }),
    ).toEqual({ fits: true, odometer: 50_280 });
  });

  it("leaves an odometer the refueling did not set", () => {
    expect(
      placeReading({
        ...plain,
        highest: 45_500,
        mileage: 47_000,
        neighbours: newest,
        odometer: 50_000,
        previousMileage: 48_000,
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("never takes the newest to or below an earlier reading", () => {
    for (const mileage of [45_500, 44_000]) {
      expect(
        placeReading({
          ...plain,
          highest: 45_500,
          mileage,
          neighbours: newest,
          odometer: 48_000,
          previousMileage: 48_000,
        }),
      ).toEqual({ fits: false });
    }
  });

  it("corrects the vehicle's only or oldest refueling", () => {
    expect(
      placeReading({
        ...plain,
        highest: null,
        mileage: 9_000,
        neighbours: { before: null, after: null },
        odometer: 90_000,
        previousMileage: 90_000,
      }),
    ).toEqual({ fits: true, odometer: 9_000 });

    expect(
      placeReading({
        ...plain,
        laterDay: 45_500,
        highest: 50_000,
        mileage: 39_000,
        neighbours: { before: null, after: 45_500 },
        odometer: 50_000,
        previousMileage: 41_000,
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("treats a new refueling, or one moved here, alike", () => {
    // Newest there: it has to move that odometer forward.
    expect(
      placeReading({
        ...plain,
        highest: 45_500,
        mileage: 49_000,
        neighbours: newest,
        odometer: 50_000,
        previousMileage: null,
      }),
    ).toEqual({ fits: false });
    expect(
      placeReading({
        ...plain,
        highest: 45_500,
        mileage: 52_000,
        neighbours: newest,
        odometer: 50_000,
        previousMileage: null,
      }),
    ).toEqual({ fits: true, odometer: 52_000 });

    // Nothing before it there: the floor is unknown.
    expect(
      placeReading({
        ...plain,
        laterDay: 45_500,
        mileage: 39_000,
        neighbours: { before: null, after: 45_500 },
        odometer: 50_000,
        previousMileage: null,
      }),
    ).toEqual({ fits: false });
  });

  it("keeps last round's edit decisions wherever the day and the release do not apply", () => {
    // The edit rule reviewed last round (date first, the newest follows its
    // own odometer down). Off the two additions — same-day readings and the
    // release of an odometer this record set — nothing may change.
    const lastRound = ({
      mileage,
      neighbours: { before, after },
      odometer,
      previousMileage,
    }: {
      mileage: number;
      neighbours: { before: number | null; after: number | null };
      odometer: number;
      previousMileage: number | null;
    }) => {
      const sameVehicle = previousMileage !== null;
      const aboveBefore = before === null ? sameVehicle : mileage > before;

      if (after !== null) {
        return aboveBefore && mileage < after
          ? { fits: true, odometer: null }
          : { fits: false };
      }

      if (mileage > odometer && (before === null || mileage > before)) {
        return { fits: true, odometer: mileage };
      }

      if (!sameVehicle || !aboveBefore) return { fits: false };

      return {
        fits: true,
        odometer: odometer === previousMileage ? mileage : null,
      };
    };

    const readings = [null, 15_000, 17_000, 17_900, 18_200, 20_000, 25_000];

    for (const before of readings) {
      for (const after of readings) {
        for (const mileage of [
          16_000, 17_000, 17_500, 18_200, 19_000, 20_000, 26_000,
        ]) {
          for (const previousMileage of [null, 17_900]) {
            const reading = {
              mileage,
              neighbours: { before, after },
              odometer: 20_000,
              previousMileage,
            };

            expect(
              placeReading({
                ...reading,
                laterDay: after,
                highest: 20_000,
                maintenanceFloor: null,
                at: plain.at,
                timeZone: plain.timeZone,
              }),
              JSON.stringify(reading),
            ).toEqual(lastRound(reading));
          }
        }
      }
    }
  });
});

/**
 * The odometer never goes backwards, but it may stand still for a short
 * while (owner, 05/11/2026). The question "Já tem um abastecimento recente"
 * offers "Completar o tanque", "Segundo tanque", "A bomba parou antes": all
 * at the same stop, so the second refuelling reads the km of the first, and
 * the strict rule made the driver type 1 km more. The same for the depot
 * refuelling right after the departure checklist, the arrival checklist
 * right after a refuelling, and a record the offline queue delivers after a
 * record of the same km sent first.
 */
const SAO_PAULO = "America/Sao_Paulo";

// 11:00 in São Paulo: the first record at the stop.
const STOP = new Date("2026-11-05T14:00:00.000Z");

const minutesFrom = (at: Date, delta: number) =>
  new Date(at.getTime() + delta * 60_000);

const reading = (
  kind: TimelineReading["kind"],
  mileage: number,
  at: Date,
): TimelineReading => ({
  kind,
  id: `${kind}-${mileage}-${at.toISOString()}`,
  mileage,
  at,
});

describe("standsStillWith", () => {
  const record = (at: Date) => ({ at, timeZone: SAO_PAULO });

  it("is less than 30 minutes apart, either side", () => {
    const stop = { at: STOP };

    expect(standsStillWith(record(minutesFrom(STOP, 29)), stop)).toBe(true);
    expect(
      standsStillWith(record(new Date(STOP.getTime() + 30 * 60_000 - 1)), stop),
    ).toBe(true);
    // The record the offline queue delivers late sits BEFORE its neighbour.
    expect(standsStillWith(record(minutesFrom(STOP, -29)), stop)).toBe(true);

    expect(standsStillWith(record(minutesFrom(STOP, 30)), stop)).toBe(false);
    expect(standsStillWith(record(minutesFrom(STOP, -30)), stop)).toBe(false);
    expect(standsStillWith(record(minutesFrom(STOP, 31)), stop)).toBe(false);
  });

  it("never for a date that is only a day, on either side", () => {
    // The web's date picker sends the start of the day in the company's
    // zone; an API client's bare day is 00:00 UTC.
    const localMidnight = new Date("2026-11-05T03:00:00.000Z");
    const utcMidnight = new Date("2026-11-05T00:00:00.000Z");

    expect(
      standsStillWith(record(minutesFrom(localMidnight, 10)), {
        at: localMidnight,
      }),
    ).toBe(false);
    expect(
      standsStillWith(record(localMidnight), {
        at: minutesFrom(localMidnight, -10),
      }),
    ).toBe(false);
    expect(standsStillWith(record(localMidnight), { at: localMidnight })).toBe(
      false,
    );
    expect(
      standsStillWith(record(utcMidnight), {
        at: minutesFrom(utcMidnight, -5),
      }),
    ).toBe(false);
  });

  it("never without the neighbour's record, nor with a date that is not one", () => {
    expect(standsStillWith(record(STOP), null)).toBe(false);
    expect(standsStillWith(record(STOP), undefined)).toBe(false);
    expect(standsStillWith(record(new Date(Number.NaN)), { at: STOP })).toBe(
      false,
    );
  });

  it("is 30 minutes, never longer than the recent-refuel window", () => {
    // A refuelling accepted at another's km is then always asked about and
    // flagged (RECENT_REFUEL). The app reads the same number.
    expect(SAME_READING_WINDOW_MINUTES).toBe(30);
    expect(SAME_READING_WINDOW_MINUTES).toBeLessThanOrEqual(
      RECENT_REFUEL_WINDOW_MINUTES,
    );
  });
});

describe("placeReading: the odometer standing still", () => {
  // The vehicle's newest record: a refuelling at 11:00 with 50.000 km, which
  // set the odometer. A new record 10 minutes later at the same km.
  const still = (overrides: Partial<ReadingOnTimeline> = {}) =>
    placeReading({
      mileage: 50_000,
      neighbours: {
        before: 50_000,
        after: null,
        beforeReading: reading("fuel", 50_000, STOP),
        afterReading: null,
      },
      laterDay: null,
      highest: 50_000,
      odometer: 50_000,
      maintenanceFloor: null,
      previousMileage: null,
      at: minutesFrom(STOP, 10),
      timeZone: SAO_PAULO,
      ...overrides,
    });

  it("accepts a second tank at the stop, up to 29 minutes after, and leaves the odometer", () => {
    expect(still()).toEqual({ fits: true, odometer: null });
    expect(still({ at: minutesFrom(STOP, 29) })).toEqual({
      fits: true,
      odometer: null,
    });
  });

  it("accepts the depot refuelling 5 minutes after the departure checklist", () => {
    expect(
      still({
        neighbours: {
          before: 50_000,
          after: null,
          beforeReading: reading("checklist", 50_000, STOP),
          afterReading: null,
        },
        at: minutesFrom(STOP, 5),
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("refuses it 30 minutes or more after, and without the record's date: the strict rule", () => {
    expect(still({ at: minutesFrom(STOP, 30) })).toEqual({ fits: false });
    expect(still({ at: minutesFrom(STOP, 31) })).toEqual({ fits: false });
    expect(still({ neighbours: { before: 50_000, after: null } })).toEqual({
      fits: false,
    });
  });

  it("never moves the odometer, forward or back", () => {
    // An odometer below the readings (a MASTER's correction): an equal
    // reading is not ahead of anything, so it stays.
    expect(still({ odometer: 49_000 })).toEqual({ fits: true, odometer: null });
    // The edited record "set" an odometer a MASTER lowered to its km, below
    // the 50.000 before it: releasing it would take the odometer up, and an
    // equal reading is not what may do that.
    expect(still({ previousMileage: 49_000, odometer: 49_000 })).toEqual({
      fits: true,
      odometer: null,
    });
  });

  it("refuses a new newest record below an odometer raised since the reading before: the strict rule", () => {
    // A service order at 11:05 took the odometer to 50.012 (and the last
    // maintenance with it); a new 50.000 at 11:10 would show it going back.
    const serviced = { odometer: 50_012, maintenanceFloor: 50_012 };

    expect(still(serviced)).toEqual({ fits: false });
    // A MASTER who raised it by hand, with no maintenance. (A record an edit
    // moves here is new here too: previousMileage null, the same answer.)
    expect(still({ odometer: 50_300 })).toEqual({ fits: false });

    // A correction of a record already on this vehicle may sit below the
    // odometer, as any correction; the odometer it did not set stays.
    expect(still({ ...serviced, previousMileage: 50_005 })).toEqual({
      fits: true,
      odometer: null,
    });

    // The strict rule itself still takes a km above the raised odometer.
    expect(still({ ...serviced, mileage: 50_013 })).toEqual({
      fits: true,
      odometer: 50_013,
    });
  });

  it("accepts a record the offline queue delivers late, at the km of the one after it", () => {
    // Tapped at 10:50 without signal; the 11:00 checklist of 50.000 was
    // sent first. Yesterday's refuelling of 49.800 is before both.
    const late = {
      at: minutesFrom(STOP, -10),
      neighbours: {
        before: 49_800,
        after: 50_000,
        beforeReading: reading("fuel", 49_800, minutesFrom(STOP, -24 * 60)),
        afterReading: reading("checklist", 50_000, STOP),
      },
    };

    expect(still(late)).toEqual({ fits: true, odometer: null });

    // An hour before it, the odometer did not stand still that long.
    expect(still({ ...late, at: minutesFrom(STOP, -60) })).toEqual({
      fits: false,
    });

    // Across midnight: 23:50 against a reading at 00:10 of the next day,
    // which is a later civil day and still bounds it, at its own km.
    const night = new Date("2026-11-06T02:50:00.000Z");

    expect(
      still({
        at: night,
        laterDay: 50_000,
        neighbours: {
          ...late.neighbours,
          afterReading: reading("checklist", 50_000, minutesFrom(night, 20)),
        },
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("accepts the same km on both sides, never with one of them far", () => {
    const around = (beforeAt: number, afterAt: number) =>
      still({
        at: STOP,
        neighbours: {
          before: 50_000,
          after: 50_000,
          beforeReading: reading("fuel", 50_000, minutesFrom(STOP, beforeAt)),
          afterReading: reading(
            "checklist",
            50_000,
            minutesFrom(STOP, afterAt),
          ),
        },
      });

    expect(around(-10, 10)).toEqual({ fits: true, odometer: null });
    expect(around(-40, 10)).toEqual({ fits: false });
    expect(around(-10, 40)).toEqual({ fits: false });
  });

  it("keeps the strict rule for a date that is only a day, on either side", () => {
    const localMidnight = new Date("2026-11-05T03:00:00.000Z");
    const utcMidnight = new Date("2026-11-05T00:00:00.000Z");
    const before = (at: Date) => ({
      before: 50_000,
      after: null,
      beforeReading: reading("fuel", 50_000, at),
      afterReading: null,
    });

    // The web's refuelling typed for today, then the app's at 00:10.
    expect(
      still({
        at: minutesFrom(localMidnight, 10),
        neighbours: before(localMidnight),
      }),
    ).toEqual({ fits: false });
    // The web's, typed for today, after the app's of 23:50.
    expect(
      still({
        at: localMidnight,
        neighbours: before(minutesFrom(localMidnight, -10)),
      }),
    ).toEqual({ fits: false });
    // Two the office typed for the same day.
    expect(
      still({ at: localMidnight, neighbours: before(localMidnight) }),
    ).toEqual({ fits: false });
    // An API client's bare day.
    expect(
      still({
        at: utcMidnight,
        neighbours: before(minutesFrom(utcMidnight, -5)),
      }),
    ).toEqual({ fits: false });
  });

  it("still refuses a new record with nothing before it, even at the km of one minutes after", () => {
    // Across midnight, so the reading after it is on a later day and binds.
    const night = new Date("2026-11-06T02:55:00.000Z");
    const first = {
      at: night,
      laterDay: 50_000,
      neighbours: {
        before: null,
        after: 50_000,
        beforeReading: null,
        afterReading: reading("checklist", 50_000, minutesFrom(night, 10)),
      },
    };

    expect(still(first)).toEqual({ fits: false });

    // The vehicle's oldest record, corrected by the office: accepted once.
    expect(still({ ...first, previousMileage: 49_990 })).toEqual({
      fits: true,
      odometer: null,
    });
  });

  it("lets an edit that set nothing take the km of the record minutes before it, the odometer left", () => {
    // 11:10, typed 50.060; a later reading of 50.400 at 14:00 set the
    // odometer.
    expect(
      still({
        previousMileage: 50_060,
        odometer: 50_400,
        highest: 50_400,
        neighbours: {
          before: 50_000,
          after: 50_400,
          beforeReading: reading("fuel", 50_000, STOP),
          afterReading: reading("checklist", 50_400, minutesFrom(STOP, 180)),
        },
      }),
    ).toEqual({ fits: true, odometer: null });
  });

  it("brings the odometer the corrected record set down to the equal reading, never below the last maintenance", () => {
    // The second tank typed 50.100 for 50.000: it set the odometer, and the
    // office corrects it to the first tank's km.
    const typo = { previousMileage: 50_100, odometer: 50_100 };

    expect(still(typo)).toEqual({ fits: true, odometer: 50_000 });
    expect(still({ ...typo, maintenanceFloor: 50_050 })).toEqual({
      fits: true,
      odometer: 50_050,
    });

    // 31 minutes after the first tank: the strict rule, as before.
    expect(still({ ...typo, at: minutesFrom(STOP, 31) })).toEqual({
      fits: false,
    });
  });

  it("places a record moved to another vehicle like a new one there", () => {
    const there = {
      mileage: 120_000,
      odometer: 120_000,
      highest: 120_000,
      neighbours: {
        before: 120_000,
        after: null,
        beforeReading: reading("checklist", 120_000, STOP),
        afterReading: null,
      },
    };

    expect(still(there)).toEqual({ fits: true, odometer: null });
    expect(still({ ...there, at: minutesFrom(STOP, 45) })).toEqual({
      fits: false,
    });
  });

  it("keeps a later civil day bounding a back-dated record, the 510.000 typo included", () => {
    // Its km is the later day's reading, days away: not standing still.
    expect(
      still({
        mileage: 48_000,
        at: minutesFrom(STOP, -4 * 24 * 60),
        odometer: 50_000,
        highest: 48_000,
        laterDay: 48_000,
        neighbours: {
          before: 45_500,
          after: 48_000,
          beforeReading: reading(
            "fuel",
            45_500,
            minutesFrom(STOP, -5 * 24 * 60),
          ),
          afterReading: reading(
            "fuel",
            48_000,
            minutesFrom(STOP, -2 * 24 * 60),
          ),
        },
      }),
    ).toEqual({ fits: false });

    // 510.000 typed for 51.000, between two readings minutes away.
    expect(
      still({
        mileage: 510_000,
        at: STOP,
        odometer: 50_000,
        highest: 48_000,
        laterDay: 48_000,
        neighbours: {
          before: 45_500,
          after: 48_000,
          beforeReading: reading("fuel", 45_500, minutesFrom(STOP, -10)),
          afterReading: reading("fuel", 48_000, minutesFrom(STOP, 10)),
        },
      }),
    ).toEqual({ fits: false });
  });

  it("changes nothing the strict rule accepts, and accepts more only at a neighbour's km", () => {
    const readings = [null, 15_000, 17_000, 17_900, 18_200, 20_000, 25_000];
    const localMidnight = new Date("2026-11-05T03:00:00.000Z");

    // Where the record is, and how far its neighbours' records are.
    const placements = [
      { name: "near", at: STOP, beforeAt: -10, afterAt: 10, still: true },
      { name: "far", at: STOP, beforeAt: -40, afterAt: 40, still: false },
      {
        name: "a day",
        at: localMidnight,
        beforeAt: -10,
        afterAt: 10,
        still: false,
      },
    ];

    for (const placement of placements) {
      for (const before of readings) {
        for (const after of readings) {
          for (const mileage of [
            16_000, 17_000, 17_900, 18_200, 19_000, 20_000, 26_000,
          ]) {
            for (const previousMileage of [null, 17_900, 20_000]) {
              for (const laterDay of [null, after]) {
                const base = {
                  mileage,
                  laterDay,
                  highest: 20_000,
                  odometer: 20_000,
                  maintenanceFloor: null,
                  previousMileage,
                  at: placement.at,
                  timeZone: SAO_PAULO,
                };
                const strict = placeReading({
                  ...base,
                  neighbours: { before, after },
                });
                const withRecords = placeReading({
                  ...base,
                  neighbours: {
                    before,
                    after,
                    beforeReading:
                      before === null
                        ? null
                        : reading(
                            "fuel",
                            before,
                            minutesFrom(placement.at, placement.beforeAt),
                          ),
                    afterReading:
                      after === null
                        ? null
                        : reading(
                            "checklist",
                            after,
                            minutesFrom(placement.at, placement.afterAt),
                          ),
                  },
                });
                const label = JSON.stringify({
                  placement: placement.name,
                  before,
                  after,
                  mileage,
                  previousMileage,
                  laterDay,
                });

                if (strict.fits || !placement.still) {
                  expect(withRecords, label).toEqual(strict);
                } else if (mileage !== before && mileage !== after) {
                  expect(withRecords, label).toEqual({ fits: false });
                }

                // Never ahead of the odometer because of an equal reading.
                if (withRecords.fits && !strict.fits) {
                  expect(
                    withRecords.odometer === null ||
                      withRecords.odometer <= base.odometer,
                    label,
                  ).toBe(true);

                  // And a new newest record never below it: standing still,
                  // not going back.
                  if (previousMileage === null && after === null) {
                    expect(mileage, label).toBeGreaterThanOrEqual(
                      base.odometer,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("endOfBusinessDay", () => {
  it("is the last instant of the company's civil day", () => {
    // Local midnight of the 28th in São Paulo, as the web's picker sends it.
    const webDate = new Date("2026-09-28T03:00:00.000Z");

    expect(endOfBusinessDay(webDate, "America/Sao_Paulo").toISOString()).toBe(
      "2026-09-29T02:59:59.999Z",
    );

    // The same instant is still the 27th in Manaus (UTC-4).
    expect(endOfBusinessDay(webDate, "America/Manaus").toISOString()).toBe(
      "2026-09-28T03:59:59.999Z",
    );
  });
});

describe("releasedOdometer", () => {
  it("is the highest reading left, floored by the last maintenance", () => {
    expect(releasedOdometer([48_000, null], null)).toBe(48_000);
    expect(releasedOdometer([48_000], 49_000)).toBe(49_000);
  });

  it("has nothing to go by without a reading or a maintenance", () => {
    expect(releasedOdometer([null], null)).toBeNull();
  });
});
