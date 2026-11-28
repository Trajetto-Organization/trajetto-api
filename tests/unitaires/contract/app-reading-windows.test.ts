import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECENT_REFUEL_WINDOW_MINUTES,
  SAME_READING_WINDOW_MINUTES,
} from "@/modules/fuel/usecases/fuel-rules";
import {
  PAUSE_COOLDOWN_MINUTES,
  PAUSE_NOTE_MIN_LENGTH,
} from "@/modules/driver-pause/rules/pause-rules";

/**
 * The app's copies of the odometer and refuelling windows (05/11/2026).
 *
 * The app accepts a km equal to the vehicle's only when it knows a reading
 * of that km less than SAME_READING_WINDOW_MINUTES away, and asks before a
 * second refuelling less than RECENT_REFUEL_WINDOW_MINUTES from another.
 * Each repository holds its own number: an API window shortened alone lets
 * the phone queue readings the server then refuses, red cards long after
 * the form that could fix them is gone. Read from the sibling checkout when
 * it is there, like what the app calls (client-routes.test.ts).
 */
const APP = resolve(process.cwd(), "..", "trajetto-mobile");
const SAME_READING = resolve(APP, "features/vehicles/same-reading-rules.ts");
const FUEL_RULES = resolve(APP, "features/fuel/fuel-rules.ts");
const PAUSE_RULES = resolve(APP, "features/pauses/pause-rules.ts");

/** The value of `const NAME = N;` in a source file, or null. */
function numberIn(path: string, name: string): number | null {
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(
    readFileSync(path, "utf8"),
  );

  return match ? Number(match[1]) : null;
}

describe.skipIf(!existsSync(SAME_READING) || !existsSync(FUEL_RULES))(
  "the app's reading windows",
  () => {
    it("lets the odometer stand still exactly as long as the API", () => {
      expect(numberIn(SAME_READING, "SAME_READING_WINDOW_MINUTES")).toBe(
        SAME_READING_WINDOW_MINUTES,
      );
    });

    it("asks about a second refuelling over the API's window", () => {
      expect(numberIn(FUEL_RULES, "RECENT_REFUEL_WINDOW_MINUTES")).toBe(
        RECENT_REFUEL_WINDOW_MINUTES,
      );
    });
  },
);

/**
 * The 5 minutes between pauses (05/11/2026): the app holds the start for as
 * long as the API refuses it. A longer wait in the app blocks a start the
 * server would take; a shorter one lets the driver tap into a 409.
 */
describe.skipIf(!existsSync(PAUSE_RULES))("the app's pause cooldown", () => {
  it("waits exactly as long as the API between two pauses", () => {
    expect(numberIn(PAUSE_RULES, "PAUSE_COOLDOWN_MINUTES")).toBe(
      PAUSE_COOLDOWN_MINUTES,
    );
  });
});

/**
 * The generic pause's reason (09/11/2026): the app asks for as many
 * non-space characters as the API refuses below. A longer minimum in the
 * app holds a reason the server would take; a shorter one lets the driver
 * tap into a 400 PAUSE_NOTE_REQUIRED.
 */
describe.skipIf(!existsSync(PAUSE_RULES))("the app's pause reason", () => {
  it("asks for exactly the API's minimum", () => {
    expect(numberIn(PAUSE_RULES, "PAUSE_NOTE_MIN_LENGTH")).toBe(
      PAUSE_NOTE_MIN_LENGTH,
    );
  });
});
