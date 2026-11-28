import { describe, expect, it } from "vitest";

import {
  isReusablePoint,
  lendingRoot,
  pickReusablePoint,
  type LenderRow,
  type PointCandidate,
} from "@/shared/delivery/geocoding/address-point-reuse";

/**
 * Which point a delivery takes from another of the company at the same door
 * (owner's report of 14/11/2026; decisions D-21 and D-23): a person's pin
 * over the geocoder's, the newest within one source, only a point at the
 * number or on the street — and always written as GEOCODER, because a
 * MANUAL copy would turn an ERP's legitimate resend into a 409 on the
 * public API's replay.
 */
const NOW = new Date("2026-11-14T15:00:00.000Z");
const ROOT = "018f0000-0000-7000-8000-0000000000a1";

function candidate(overrides: Partial<PointCandidate> = {}): PointCandidate {
  return {
    latitude: -22.5084,
    longitude: -43.1735,
    geo_source: "GEOCODER",
    geo_precision: "ADDRESS",
    geo_updated_at: new Date("2026-11-10T10:00:00.000Z"),
    root: ROOT,
    ...overrides,
  };
}

describe("the point taken", () => {
  it("is a dispatcher's pin over a newer point the geocoder found", () => {
    const pin = candidate({
      latitude: -22.51,
      geo_source: "MANUAL",
      geo_precision: null,
      geo_updated_at: new Date("2026-11-01T10:00:00.000Z"),
    });
    const found = candidate({
      geo_updated_at: new Date("2026-11-13T10:00:00.000Z"),
    });

    expect(pickReusablePoint([found, pin], NOW)).toMatchObject({
      latitude: -22.51,
    });
    expect(pickReusablePoint([pin, found], NOW)).toMatchObject({
      latitude: -22.51,
    });
  });

  it("is the newest within one source, an undated one last", () => {
    const older = candidate({ latitude: -22.1 });
    const newer = candidate({
      latitude: -22.2,
      geo_updated_at: new Date("2026-11-12T10:00:00.000Z"),
    });
    const undated = candidate({ latitude: -22.3, geo_updated_at: null });

    expect(pickReusablePoint([older, undated, newer], NOW)?.latitude).toBe(
      -22.2,
    );
    expect(pickReusablePoint([undated], NOW)?.latitude).toBe(-22.3);
  });

  it("is written as GEOCODER, RESOLVED, now — ADDRESS for a pin, the origin's level otherwise", () => {
    expect(
      pickReusablePoint(
        [candidate({ geo_source: "MANUAL", geo_precision: null })],
        NOW,
      ),
    ).toEqual({
      latitude: -22.5084,
      longitude: -43.1735,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
      geo_updated_at: NOW,
      geo_copied_from: ROOT,
    });
    expect(
      pickReusablePoint([candidate({ geo_precision: "STREET" })], NOW),
    ).toMatchObject({ geo_source: "GEOCODER", geo_precision: "STREET" });
  });
});

describe("where the copy says it came from", () => {
  // Pre-push review of the batch of 14/11/2026: a copy with nothing tying
  // it to its source stayed wrong for good once the source's pin was
  // corrected or cleared. It names the root, so the root's pin reaches it.
  it("is the root the candidate lends as", () => {
    expect(
      pickReusablePoint([candidate({ root: "the-root" })], NOW)
        ?.geo_copied_from,
    ).toBe("the-root");
  });

  it("is nothing when that root is the delivery taking it back", () => {
    // An address edited back to the door whose point it had lent: its own
    // point again, as its own.
    expect(
      pickReusablePoint([candidate()], NOW, ROOT)?.geo_copied_from,
    ).toBeNull();
    expect(
      pickReusablePoint([candidate()], NOW, "another")?.geo_copied_from,
    ).toBe(ROOT);
  });
});

describe("the root a delivery lends its point as", () => {
  const KEY = "door";
  const row = (overrides: Partial<LenderRow> = {}): LenderRow => ({
    id: "copy",
    businessId: "A",
    address_key: KEY,
    latitude: -22.5,
    longitude: -43.1,
    geo_source: "GEOCODER",
    geo_copied_from: "root",
    ...overrides,
  });
  const rootRow = (overrides: Partial<LenderRow> = {}) =>
    row({
      id: "root",
      geo_source: "MANUAL",
      geo_copied_from: null,
      ...overrides,
    });
  const lookup =
    (...rows: LenderRow[]) =>
    (id: string) =>
      rows.find((entry) => entry.id === id);

  it("is its own for a pin or a point of its own", () => {
    expect(lendingRoot(rootRow(), lookup())).toBe("root");
    expect(lendingRoot(row({ geo_copied_from: null }), lookup(rootRow()))).toBe(
      "copy",
    );
    // A pin is its own root even with a link an older image left behind.
    expect(lendingRoot(row({ geo_source: "MANUAL" }), lookup(rootRow()))).toBe(
      "copy",
    );
  });

  it("is the copy's root while the root, at the same door, holds the same point", () => {
    expect(lendingRoot(row(), lookup(rootRow()))).toBe("root");
  });

  it("is none once the root dropped the point at that door — cleared or moved", () => {
    // A closed copy the follow-up left as it was must not hand the point a
    // person just took away to the next delivery at the door.
    expect(
      lendingRoot(row(), lookup(rootRow({ latitude: null, longitude: null }))),
    ).toBeNull();
    expect(lendingRoot(row(), lookup(rootRow({ latitude: -22.6 })))).toBeNull();
  });

  it("is its own when the root is gone, of another company or at another door", () => {
    expect(lendingRoot(row(), lookup())).toBe("copy");
    expect(lendingRoot(row(), lookup(rootRow({ businessId: "B" })))).toBe(
      "copy",
    );
    expect(
      lendingRoot(row(), lookup(rootRow({ address_key: "elsewhere" }))),
    ).toBe("copy");
  });
});

describe("no point", () => {
  it("from a district, a city or an answer without a point", () => {
    for (const geo_precision of ["NEIGHBORHOOD", "CITY", null]) {
      expect(
        isReusablePoint(candidate({ geo_precision })),
        String(geo_precision),
      ).toBe(false);
    }
    expect(
      isReusablePoint(
        candidate({ latitude: null, longitude: null, geo_source: null }),
      ),
    ).toBe(false);
    expect(isReusablePoint(candidate({ longitude: null }))).toBe(false);
    expect(isReusablePoint(candidate({ latitude: Number.NaN }))).toBe(false);
  });

  it("when nobody at the door has one", () => {
    expect(pickReusablePoint([], NOW)).toBeNull();
    expect(
      pickReusablePoint([candidate({ geo_precision: "CITY" })], NOW),
    ).toBeNull();
  });
});
