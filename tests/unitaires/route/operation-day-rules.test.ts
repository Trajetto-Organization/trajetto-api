import { describe, expect, it } from "vitest";

import {
  FAILURE_AUTHORIZATIONS,
  isFailureOccurrence,
  stopSettledAt,
} from "@/shared/route/operation-day-rules";

describe("when an occurrence is an insucesso", () => {
  it("is a blocking type that needs no authorisation or already has it", () => {
    expect(isFailureOccurrence(true, "NOT_REQUIRED")).toBe(true);
    expect(isFailureOccurrence(true, "APPROVED")).toBe(true);
  });

  it("is not while a manager has still to decide (decision 6.3)", () => {
    expect(isFailureOccurrence(true, "PENDING")).toBe(false);
  });

  it("is not when refused or replaced", () => {
    expect(isFailureOccurrence(true, "DENIED")).toBe(false);
    expect(isFailureOccurrence(true, "SUPERSEDED")).toBe(false);
  });

  it("is never an informational type, whatever its authorisation", () => {
    for (const status of FAILURE_AUTHORIZATIONS) {
      expect(isFailureOccurrence(false, status)).toBe(false);
    }

    expect(isFailureOccurrence(undefined, "NOT_REQUIRED")).toBe(false);
    expect(isFailureOccurrence(true, null)).toBe(false);
  });
});

describe("when a stop settled", () => {
  const completed = new Date("2026-09-17T13:00:00.000Z");
  const edited = new Date("2026-09-18T09:00:00.000Z");

  it("is its outcome's hour, not a later edit of the row", () => {
    expect(stopSettledAt(completed, edited)).toEqual(completed);
  });

  it("falls back to the row's update when there is no outcome hour", () => {
    expect(stopSettledAt(null, edited)).toEqual(edited);
  });

  it("never lands after the row was last written", () => {
    expect(stopSettledAt(edited, completed)).toEqual(completed);
  });
});
