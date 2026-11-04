import { describe, expect, it } from "vitest";

import { InMemoryBusinessSettingsRepository } from "@/modules/business/repositories/in-memory/in-memory-business-settings-repository";
import { AppError } from "@/shared/errors/AppError";
import {
  GeofenceCheck,
  geofencePositionAgeMs,
  readAccuracy,
} from "@/shared/delivery/geofence/geofence-check";

/**
 * The server's half of the geofence (plan of 02/11/2026, E4): the company's
 * mode and radius applied to one action at the customer's address. It
 * records the distance and the verdict on every driver action, refuses only
 * a fresh arrival or proof outside the radius under BLOCK, and never an
 * occurrence or a submission the app queued offline (decision D14).
 */
const BUSINESS = "018fe900-0000-7000-8000-00000000000a";
const NOW = new Date("2026-11-03T15:00:00.000Z");

/** Praça da Sé, and two positions north of it. */
const ADDRESS = {
  latitude: -23.55052,
  longitude: -46.633308,
  geo_source: "MANUAL",
  geo_precision: null,
};
const AT_800_M = { latitude: -23.54332, longitude: -46.633308 };
const AT_300_M = { latitude: -23.54782, longitude: -46.633308 };

async function checkFor(
  settings: {
    arrival_geofence_mode?: "DISABLED" | "ALERT" | "BLOCK";
    arrival_geofence_radius_m?: number;
  } | null,
) {
  const repository = new InMemoryBusinessSettingsRepository();

  if (settings) {
    await repository.save({
      businessId: BUSINESS,
      updatedById: "018fe900-0000-7000-8000-0000000000a1",
      ...settings,
    });
  }

  return new GeofenceCheck(repository);
}

const base = {
  businessId: BUSINESS,
  enabledModules: ["FLEET", "DELIVERIES"],
  address: ADDRESS,
  accuracy: 15,
  positionAgeMs: 5_000,
  occurredAt: null,
  now: NOW,
};

describe("GeofenceCheck", () => {
  it("records the distance and nothing else for a company that never set it", async () => {
    const check = await checkFor(null);

    await expect(
      check.evaluate({ ...base, action: "ARRIVAL", position: AT_800_M }),
    ).resolves.toEqual({
      distance_m: 800.6,
      accuracy_m: 15,
      geofence_outcome: "NOT_EVALUATED",
    });
  });

  it("refuses a fresh arrival outside the radius under BLOCK, with the distance", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    const refusal = await check
      .evaluate({ ...base, action: "ARRIVAL", position: AT_800_M })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({
      statusCode: 422,
      code: "ARRIVAL_OUTSIDE_GEOFENCE",
    });
    expect((refusal as AppError).message).toContain("801 m");
    expect((refusal as AppError).message).toContain("500 m");
    expect((refusal as AppError).message).toContain("registrar a chegada");
  });

  it("refuses a fresh proof outside the radius under BLOCK", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({ ...base, action: "PROOF", position: AT_800_M }),
    ).rejects.toMatchObject({
      code: "ARRIVAL_OUTSIDE_GEOFENCE",
      message: expect.stringContaining("comprovar a entrega"),
    });
  });

  it("flags, never refuses, an occurrence outside the radius under BLOCK", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({ ...base, action: "OCCURRENCE", position: AT_800_M }),
    ).resolves.toMatchObject({ geofence_outcome: "OUTSIDE" });
  });

  it("flags, never refuses, an arrival the app queued offline", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({
        ...base,
        action: "ARRIVAL",
        position: AT_800_M,
        occurredAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      }),
    ).resolves.toEqual({
      distance_m: 800.6,
      accuracy_m: 15,
      geofence_outcome: "OUTSIDE",
    });
  });

  it("accepts an arrival inside the radius under BLOCK", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({ ...base, action: "ARRIVAL", position: AT_300_M }),
    ).resolves.toMatchObject({ geofence_outcome: "INSIDE", distance_m: 300.2 });
  });

  it("accepts and flags an arrival outside the radius under ALERT", async () => {
    const check = await checkFor({ arrival_geofence_mode: "ALERT" });

    await expect(
      check.evaluate({ ...base, action: "ARRIVAL", position: AT_800_M }),
    ).resolves.toMatchObject({ geofence_outcome: "OUTSIDE" });
  });

  it("follows the company's radius", async () => {
    const check = await checkFor({
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 1_000,
    });

    await expect(
      check.evaluate({ ...base, action: "ARRIVAL", position: AT_800_M }),
    ).resolves.toMatchObject({ geofence_outcome: "INSIDE" });
  });

  it("never blocks without the accuracy an older app does not send", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({
        ...base,
        action: "ARRIVAL",
        position: AT_800_M,
        accuracy: null,
        positionAgeMs: null,
      }),
    ).resolves.toEqual({
      distance_m: 800.6,
      accuracy_m: null,
      geofence_outcome: "NOT_EVALUATED",
    });
  });

  it("never blocks an address without a point", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({
        ...base,
        action: "PROOF",
        position: AT_800_M,
        address: { latitude: null, longitude: null, geo_source: null },
      }),
    ).resolves.toEqual({
      distance_m: null,
      accuracy_m: 15,
      geofence_outcome: "NOT_EVALUATED",
    });
  });

  it("ignores the geocoder's level on a point the dispatcher pinned", async () => {
    const check = await checkFor({ arrival_geofence_mode: "ALERT" });

    await expect(
      check.evaluate({
        ...base,
        action: "ARRIVAL",
        position: AT_800_M,
        address: { ...ADDRESS, geo_source: "MANUAL", geo_precision: "CITY" },
      }),
    ).resolves.toMatchObject({ geofence_outcome: "OUTSIDE" });

    await expect(
      check.evaluate({
        ...base,
        action: "ARRIVAL",
        position: AT_800_M,
        address: { ...ADDRESS, geo_source: "GEOCODER", geo_precision: "CITY" },
      }),
    ).resolves.toMatchObject({ geofence_outcome: "NOT_EVALUATED" });
  });

  it("is off for a company without the deliveries module (item M6)", async () => {
    const check = await checkFor({ arrival_geofence_mode: "BLOCK" });

    await expect(
      check.evaluate({
        ...base,
        enabledModules: ["FLEET"],
        action: "ARRIVAL",
        position: AT_800_M,
      }),
    ).resolves.toMatchObject({ geofence_outcome: "NOT_EVALUATED" });
  });
});

describe("geofencePositionAgeMs", () => {
  it("is the tap minus the fix, both on the phone's clock", () => {
    expect(
      geofencePositionAgeMs({
        tappedAt: "2026-11-03T12:00:30.000Z",
        positionRecordedAt: "2026-11-03T12:00:00.000Z",
      }),
    ).toBe(30_000);
  });

  it("falls back to the send stamp when there is no tap instant", () => {
    expect(
      geofencePositionAgeMs({
        tappedAt: undefined,
        sentAt: "2026-11-03T12:05:00.000Z",
        positionRecordedAt: "2026-11-03T12:00:00.000Z",
      }),
    ).toBe(5 * 60 * 1000);
  });

  it("is unknown without the fix's stamp, and never negative", () => {
    expect(
      geofencePositionAgeMs({
        tappedAt: "2026-11-03T12:00:30.000Z",
        positionRecordedAt: undefined,
      }),
    ).toBeNull();
    expect(
      geofencePositionAgeMs({
        tappedAt: "2026-11-03T12:00:00.000Z",
        positionRecordedAt: "2026-11-03T12:00:01.000Z",
      }),
    ).toBe(0);
    expect(
      geofencePositionAgeMs({
        tappedAt: "não é data",
        positionRecordedAt: "2026-11-03T12:00:01.000Z",
      }),
    ).toBeNull();
  });
});

describe("readAccuracy", () => {
  it("keeps a usable number and drops anything else", () => {
    expect(readAccuracy(12.5)).toBe(12.5);
    expect(readAccuracy(0)).toBe(0);
    expect(readAccuracy(-1)).toBeNull();
    expect(readAccuracy(Number.NaN)).toBeNull();
    expect(readAccuracy(undefined)).toBeNull();
    expect(readAccuracy(null)).toBeNull();
  });
});
