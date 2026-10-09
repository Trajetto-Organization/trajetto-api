import { describe, expect, it } from "vitest";

import {
  endPauseBody,
  reportQuery,
  startPauseBody,
} from "@/modules/driver-pause/schemas/driver-pause-schemas";

/**
 * What the pause routes accept (docs/contratos-app/pauses.md). From the
 * app's offline queue a 400 is a permanent failure, so only what is really
 * wrong is refused: a phone with no fix or a sloppy note goes through.
 */

const KEY = "018f2000-0000-7000-8000-000000000001";

describe("the start body", () => {
  it("takes a missing fix as no coordinates, never as the point 0,0", () => {
    for (const nothing of [null, "", undefined]) {
      const body = startPauseBody.parse({
        kind: "MEAL",
        start_submission_id: KEY,
        latitude: nothing,
        longitude: nothing,
      });

      expect(body.latitude).toBeUndefined();
      expect(body.longitude).toBeUndefined();
    }

    expect(
      startPauseBody.parse({ kind: "MEAL", start_submission_id: KEY, latitude: "-23.55" }).latitude,
    ).toBe(-23.55);

    expect(
      startPauseBody.safeParse({ kind: "MEAL", start_submission_id: KEY, latitude: 91 }).success,
    ).toBe(false);
  });

  it("cleans the note, and refuses only one that is really too long", () => {
    expect(
      startPauseBody.parse({ kind: "REST", start_submission_id: KEY, note: "  Posto   BR \n 116 " })
        .note,
    ).toBe("Posto BR 116");

    expect(startPauseBody.parse({ kind: "REST", start_submission_id: KEY, note: "   " }).note).toBeNull();

    // 250 characters that clean down to 200.
    expect(
      startPauseBody.safeParse({
        kind: "REST",
        start_submission_id: KEY,
        note: `${"a".repeat(200)}${" ".repeat(50)}`,
      }).success,
    ).toBe(true);

    expect(
      startPauseBody.safeParse({ kind: "REST", start_submission_id: KEY, note: "a".repeat(201) })
        .success,
    ).toBe(false);
  });

  it("names the pause kinds it knows and requires a real key", () => {
    const wrongKind = startPauseBody.safeParse({ kind: "LUNCH", start_submission_id: KEY });

    expect(wrongKind.success).toBe(false);
    expect(JSON.stringify(wrongKind.error?.issues)).toContain("MEAL, REST ou OTHER");

    expect(startPauseBody.safeParse({ kind: "MEAL", start_submission_id: "abc" }).success).toBe(
      false,
    );
  });
});

describe("the end body", () => {
  it("carries the start it may have to create the pause from", () => {
    const body = endPauseBody.parse({
      start_submission_id: KEY,
      end_submission_id: "018f2000-0000-7000-8000-000000000002",
      start: { kind: "OTHER", note: " Banheiro ", latitude: null },
    });

    expect(body.start).toEqual({ kind: "OTHER", note: "Banheiro" });
  });
});

describe("the report query", () => {
  it("reads the period and both filters, and refuses what the API cannot answer", () => {
    expect(
      reportQuery.parse({
        from: "2026-09-01",
        to: "2026-09-07",
        driverId: KEY,
        flag: "MEAL_SHORT,INTERJORNADA_SHORT",
        page: "2",
        pageSize: "20",
      }),
    ).toEqual({
      from: "2026-09-01",
      to: "2026-09-07",
      driverId: [KEY],
      flag: ["MEAL_SHORT", "INTERJORNADA_SHORT"],
      page: 2,
      pageSize: 20,
    });

    expect(reportQuery.safeParse({ from: "01/09/2026" }).success).toBe(false);
    expect(reportQuery.safeParse({ flag: "TIRED" }).success).toBe(false);
    expect(reportQuery.safeParse({ driverId: "not-a-uuid" }).success).toBe(false);
  });
});
