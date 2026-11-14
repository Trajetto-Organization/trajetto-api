import { describe, expect, it } from "vitest";

import {
  isReusablePoint,
  pickReusablePoint,
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

function candidate(overrides: Partial<PointCandidate> = {}): PointCandidate {
  return {
    latitude: -22.5084,
    longitude: -43.1735,
    geo_source: "GEOCODER",
    geo_precision: "ADDRESS",
    geo_updated_at: new Date("2026-11-10T10:00:00.000Z"),
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
    });
    expect(
      pickReusablePoint([candidate({ geo_precision: "STREET" })], NOW),
    ).toMatchObject({ geo_source: "GEOCODER", geo_precision: "STREET" });
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
