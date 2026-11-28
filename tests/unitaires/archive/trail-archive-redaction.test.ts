import { describe, expect, it } from "vitest";

import {
  TRAIL_CSV_COLUMNS,
  withoutRedactedDrivers,
} from "@/shared/archive/trail-archive";

/**
 * The archived trail and a driver removed and anonymized (plano-escala
 * F3-27, decision D49): the archive's objects are not rewritten per
 * request, so a restored day must leave the driver's rows out. A restore
 * that forgot would hand back, for 180 days, the GPS trail of a person who
 * asked to be removed.
 */
describe("a restored day of the archived trail", () => {
  const header = TRAIL_CSV_COLUMNS.join(",");
  const gone = "018fe300-0000-7000-8000-0000000000aa";
  const kept = "018fe300-0000-7000-8000-0000000000bb";
  const line = (driver: string, minute: number) =>
    `${driver},2026-11-01T10:0${minute}:00.000Z,,-23.5,-46.6,5,,,80`;

  it("keeps the driver id first, the column the filter reads", () => {
    expect(TRAIL_CSV_COLUMNS[0]).toBe("driver_id");
  });

  it("leaves out the redacted drivers' lines and keeps the header", () => {
    const lines = [header, line(gone, 1), line(kept, 2), line(gone, 3)];

    expect(withoutRedactedDrivers(lines, new Set([gone]))).toEqual([
      header,
      line(kept, 2),
    ]);
  });

  it("keeps every line when nobody is redacted, and nothing of nothing", () => {
    const lines = [header, line(kept, 1)];

    expect(withoutRedactedDrivers(lines, new Set())).toEqual(lines);
    expect(withoutRedactedDrivers([], new Set([gone]))).toEqual([]);
  });
});
