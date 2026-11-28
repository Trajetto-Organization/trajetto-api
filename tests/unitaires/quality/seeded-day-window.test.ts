import { describe, expect, it } from "vitest";

import { dayBounds } from "@/shared/rollup/tenant-day-rules";
import { businessDateKey, shiftDateKey } from "@/shared/time/business-day";

import { seededDayWindow } from "../../E2E/support/seeded-day";

/**
 * The rollup E2Es (tenant-day-rollup, dashboard-rollup-equivalence) seed
 * deliveries a minute either side of several zones' midnights and look
 * them up with seededDayWindow. A window centred on the clock instead of on
 * the seeded midnight found nothing after 17:01 UTC, and those files failed
 * only on evening runs. Every hour of the day, every zone the files use as
 * a company's, every day back they ask about: the window holds the seeds.
 */
const SEED_ZONES = [
  "America/Sao_Paulo",
  "America/Rio_Branco",
  "America/Noronha",
  "America/Manaus",
  "UTC",
];
const COMPANY_ZONES = SEED_ZONES.slice(0, 4);
const BACKS = [0, 1, 2, 5, 8, 9, 15, 31, 40, 62, 95, 200, 300, 380];

/** The seeds around one zone's midnight `back` days before `now`. */
function seedsAround(now: Date, zone: string, back: number): Date[] {
  const midnight = dayBounds(
    shiftDateKey(businessDateKey(now, zone), -back),
    zone,
  ).from.getTime();

  return [-60_000, 0, 60_000].map((offset) => new Date(midnight + offset));
}

function seedsOf(now: Date, back: number): Date[] {
  return SEED_ZONES.flatMap((zone) => seedsAround(now, zone, back));
}

describe("seededDayWindow", () => {
  // What the files read: the seeds around the company's own midnight, two
  // of them on one UTC day (twoOfOneUtcDay). Near UTC's midnight the other
  // zones' "same day back" is another calendar date, and may fall outside.
  it("holds the seeds around the company's midnight, whatever the hour", () => {
    const utcDay = (instant: Date) => instant.toISOString().slice(0, 10);

    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 10, 25, hour, 27));

      for (const zone of COMPANY_ZONES) {
        for (const back of BACKS) {
          const { gte, lt } = seededDayWindow(now, zone, back);
          const seeds = seedsAround(now, zone, back);
          const label = `${now.toISOString()} ${zone} ${back} days back`;

          for (const seed of seeds) {
            expect(seed >= gte && seed < lt, label).toBe(true);
          }

          expect(utcDay(seeds[1]), label).toBe(utcDay(seeds[2]));
        }
      }
    }
  });

  it("holds none of the seeds of the days next to it", () => {
    const now = new Date(Date.UTC(2026, 10, 25, 21, 27));
    const { gte, lt } = seededDayWindow(now, "America/Sao_Paulo", 40);

    for (const back of [39, 41]) {
      for (const seed of seedsOf(now, back)) {
        expect(seed >= gte && seed < lt, seed.toISOString()).toBe(false);
      }
    }
  });
});
