import { describe, expect, it } from "vitest";

import {
  bearingDegrees,
  buildPolyline,
  distanceAlongToReach,
  haversineMetres,
  offsetPoint,
  pointAt,
  type LngLat,
} from "./geometry";

// One degree of latitude is ~111.2 km on the mean-radius sphere; São Paulo
// sits at ~23.5° S, where a degree of longitude is ~102 km.
const PAULISTA: LngLat = [-46.656, -23.5615];

describe("haversineMetres", () => {
  it("is zero for the same point and symmetric", () => {
    const other: LngLat = [-46.66, -23.556];

    expect(haversineMetres(PAULISTA, PAULISTA)).toBe(0);
    expect(haversineMetres(PAULISTA, other)).toBeCloseTo(
      haversineMetres(other, PAULISTA),
      9,
    );
  });

  it("measures a degree of latitude as ~111.2 km", () => {
    expect(haversineMetres([0, 0], [0, 1])).toBeCloseTo(111_195, -1);
  });

  it("matches a known city distance within a metre", () => {
    // Avenida Paulista 1000 → Rua Augusta 1500, ~735 m apart.
    const augusta: LngLat = [-46.66, -23.556];

    expect(haversineMetres(PAULISTA, augusta)).toBeGreaterThan(720);
    expect(haversineMetres(PAULISTA, augusta)).toBeLessThan(750);
  });
});

describe("bearingDegrees", () => {
  it("points north, east, south and west", () => {
    expect(bearingDegrees([0, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(bearingDegrees([0, 0], [1, 0])).toBeCloseTo(90, 6);
    expect(bearingDegrees([0, 1], [0, 0])).toBeCloseTo(180, 6);
    expect(bearingDegrees([1, 0], [0, 0])).toBeCloseTo(270, 6);
  });

  it("always lands in [0, 360)", () => {
    const value = bearingDegrees([0, 0], [-0.0001, 0.0001]);

    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(360);
    expect(value).toBeCloseTo(315, 1);
  });
});

describe("buildPolyline", () => {
  it("accumulates the distances and drops repeated points", () => {
    const line = buildPolyline([
      [0, 0],
      [0, 0],
      [0, 0.001],
      [0.001, 0.001],
    ]);

    expect(line.points).toHaveLength(3);
    expect(line.cumulative[0]).toBe(0);
    expect(line.cumulative[1]).toBeCloseTo(111.195, 2);
    expect(line.length).toBeCloseTo(
      line.cumulative[1] + haversineMetres([0, 0.001], [0.001, 0.001]),
      6,
    );
  });

  it("refuses an empty line", () => {
    expect(() => buildPolyline([])).toThrow();
  });
});

describe("pointAt", () => {
  const line = buildPolyline([
    [0, 0],
    [0, 0.001],
    [0.001, 0.001],
  ]);

  it("interpolates inside a segment, with that segment's heading", () => {
    const half = pointAt(line, line.cumulative[1] / 2);

    expect(half.lng).toBeCloseTo(0, 9);
    expect(half.lat).toBeCloseTo(0.0005, 6);
    expect(half.heading).toBeCloseTo(0, 3);
  });

  it("turns with the line", () => {
    const after = pointAt(line, line.cumulative[1] + 10);

    expect(after.lat).toBeCloseTo(0.001, 6);
    expect(after.lng).toBeGreaterThan(0);
    expect(after.heading).toBeCloseTo(90, 1);
  });

  it("clamps before the start and after the end", () => {
    expect(pointAt(line, -50)).toMatchObject({ lng: 0, lat: 0 });

    const end = pointAt(line, line.length + 500);

    expect(end.lng).toBeCloseTo(0.001, 9);
    expect(end.lat).toBeCloseTo(0.001, 9);
    expect(end.heading).toBeCloseTo(90, 1);
  });

  it("works on a single-point line", () => {
    const dot = buildPolyline([[-46.7, -23.5]]);

    expect(pointAt(dot, 10)).toMatchObject({ lng: -46.7, lat: -23.5 });
  });
});

describe("distanceAlongToReach", () => {
  const line = buildPolyline([
    [0, 0],
    [0, 0.01],
  ]);

  it("finds where the line comes within the given straight distance of a target", () => {
    const target: LngLat = [0, 0.01];
    const along = distanceAlongToReach(line, target, 600, line.length);
    const at = pointAt(line, along);

    expect(haversineMetres([at.lng, at.lat], target)).toBeCloseTo(600, 0);
  });

  it("answers the start when the whole line is already closer", () => {
    expect(distanceAlongToReach(line, [0, 0.0001], 5_000, line.length)).toBe(0);
  });
});

describe("offsetPoint", () => {
  it("moves the given metres along the given bearing", () => {
    const moved = offsetPoint(PAULISTA, 100, 90);

    expect(haversineMetres(PAULISTA, moved)).toBeCloseTo(100, 3);
    expect(bearingDegrees(PAULISTA, moved)).toBeCloseTo(90, 1);
  });
});
