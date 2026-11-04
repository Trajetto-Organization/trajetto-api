import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GEOFENCE_MAX_POSITION_AGE_MS,
  GEOFENCE_RECENT_SUBMISSION_MS,
  geofenceDecision,
  geofenceVerdict,
  isRecentSubmission,
  type GeofenceDecisionInput,
  type GeofenceVerdict,
  type GeofenceVerdictInput,
} from "@/shared/delivery/geofence/geofence-rules";

/**
 * The geofence rule (plan of 02/11/2026, E2) against the cases the driver's
 * app runs too: the same position must get the same verdict on the phone,
 * which warns or blocks at the tap, and on the server, which records the
 * distance and refuses only a fresh arrival or proof.
 */
interface SharedCases {
  verdict: Array<{
    name: string;
    input: GeofenceVerdictInput;
    expected: GeofenceVerdict;
  }>;
  decision: Array<{
    name: string;
    input: GeofenceDecisionInput;
    expected: string;
  }>;
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, "fixtures/geofence-verdict-cases.json"), "utf8"),
) as SharedCases;

describe("geofenceVerdict", () => {
  it.each(CASES.verdict.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(geofenceVerdict(entry.input)).toEqual(entry.expected);
    },
  );
});

describe("geofenceDecision", () => {
  it.each(CASES.decision.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(geofenceDecision(entry.input)).toBe(entry.expected);
    },
  );
});

describe("the windows", () => {
  it("call a fix stale and a submission queued after the same two minutes", () => {
    expect(GEOFENCE_MAX_POSITION_AGE_MS).toBe(2 * 60 * 1000);
    expect(GEOFENCE_RECENT_SUBMISSION_MS).toBe(2 * 60 * 1000);
  });
});

describe("isRecentSubmission", () => {
  const now = new Date("2026-11-03T15:00:00.000Z");

  it("takes a submission without a tap instant as made now", () => {
    expect(isRecentSubmission(null, now)).toBe(true);
    expect(isRecentSubmission(undefined, now)).toBe(true);
  });

  it("takes a tap up to two minutes old as fresh, and an older one as queued", () => {
    expect(
      isRecentSubmission(new Date(now.getTime() - 2 * 60 * 1000), now),
    ).toBe(true);
    expect(
      isRecentSubmission(new Date(now.getTime() - 2 * 60 * 1000 - 1), now),
    ).toBe(false);
  });
});
