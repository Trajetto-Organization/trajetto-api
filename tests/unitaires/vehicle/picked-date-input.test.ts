import { describe, expect, it } from "vitest";

import {
  isPickedDateInput,
  pickedDateFromInput,
} from "@/shared/vehicle/record-dates";

/**
 * The date a fleet form or client sends (fueling, checklist, service order).
 * A bare day reached Prisma as a string (500) or became 00:00 UTC, the
 * evening before in Brazil.
 */
describe("pickedDateFromInput", () => {
  it("turns a day into the instant it starts in the company's zone", () => {
    expect(pickedDateFromInput("2026-10-06", "America/Sao_Paulo")).toEqual(
      new Date("2026-10-06T03:00:00.000Z"),
    );
    expect(pickedDateFromInput("2026-10-06", "America/Rio_Branco")).toEqual(
      new Date("2026-10-06T05:00:00.000Z"),
    );
  });

  it("falls back to the default zone for an unknown or missing one", () => {
    expect(pickedDateFromInput("2026-10-06", null)).toEqual(
      new Date("2026-10-06T03:00:00.000Z"),
    );
    expect(pickedDateFromInput("2026-10-06", "Mars/Olympus")).toEqual(
      new Date("2026-10-06T03:00:00.000Z"),
    );
  });

  it("leaves instants, Dates and empty values alone", () => {
    const instant = "2026-10-06T14:00:00.000-03:00";
    const date = new Date("2026-10-06T12:00:00.000Z");

    expect(pickedDateFromInput(instant, "America/Sao_Paulo")).toBe(instant);
    expect(pickedDateFromInput(date, "America/Sao_Paulo")).toBe(date);
    expect(pickedDateFromInput(undefined, "America/Sao_Paulo")).toBeUndefined();
    expect(pickedDateFromInput(null, "America/Sao_Paulo")).toBeNull();
  });
});

describe("isPickedDateInput", () => {
  it("accepts a calendar day or an ISO instant", () => {
    expect(isPickedDateInput("2026-10-06")).toBe(true);
    expect(isPickedDateInput("2028-02-29")).toBe(true);
    expect(isPickedDateInput("2026-10-06T14:00:00.000Z")).toBe(true);
  });

  it("refuses a day the calendar does not have and garbage", () => {
    expect(isPickedDateInput("2026-02-30")).toBe(false);
    expect(isPickedDateInput("2026-13-01")).toBe(false);
    expect(isPickedDateInput("ontem")).toBe(false);
  });
});
