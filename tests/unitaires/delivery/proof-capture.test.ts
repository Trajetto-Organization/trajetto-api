import { describe, expect, it } from "vitest";

import {
  deviceLabel,
  normalizeDeviceId,
  resolvePhotoTakenAt,
} from "@/shared/delivery/proof-capture";

/**
 * What the phone says about the receipt photo (decision 14.8, design §7.2 of
 * the ICP proof): when it was taken and which phone took it. Printed on the
 * proof document, so it is advisory and never refuses a proof.
 */
const NOW = new Date("2026-10-05T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("resolvePhotoTakenAt", () => {
  it("moves the photo instant by the phone's clock error, like occurred_at", () => {
    // The phone runs 10 minutes fast: it sent at 15:10 by its clock.
    expect(
      resolvePhotoTakenAt({
        photoTakenAt: "2026-10-05T13:10:00.000Z",
        clientSentAt: "2026-10-05T15:10:00.000Z",
        occurredAt: new Date("2026-10-05T13:30:00.000Z"),
        now: NOW,
      })?.toISOString(),
    ).toBe("2026-10-05T13:00:00.000Z");
  });

  it("never puts the photo after the tap that sent it", () => {
    const occurredAt = new Date("2026-10-05T13:00:00.000Z");

    expect(
      resolvePhotoTakenAt({
        photoTakenAt: "2026-10-05T14:00:00.000Z",
        occurredAt,
        now: NOW,
      }),
    ).toEqual(occurredAt);
  });

  it("is capped at now when the proof carries no tap", () => {
    expect(
      resolvePhotoTakenAt({
        photoTakenAt: new Date(NOW.getTime() + HOUR).toISOString(),
        occurredAt: null,
        now: NOW,
      }),
    ).toEqual(NOW);
  });

  it("is null when absent, unreadable or older than the offline week", () => {
    expect(resolvePhotoTakenAt({ photoTakenAt: undefined, occurredAt: null, now: NOW })).toBeNull();
    expect(resolvePhotoTakenAt({ photoTakenAt: "ontem", occurredAt: null, now: NOW })).toBeNull();
    expect(
      resolvePhotoTakenAt({
        photoTakenAt: new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString(),
        occurredAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("normalizeDeviceId", () => {
  it("keeps an Android ID (16 hex) or a UUID, in lower case", () => {
    expect(normalizeDeviceId("A1B2C3D4E5F60718")).toBe("a1b2c3d4e5f60718");
    expect(normalizeDeviceId("018F0000-0000-7000-8000-0000000000AA")).toBe(
      "018f0000-0000-7000-8000-0000000000aa",
    );
  });

  it("turns anything else into null, never a refusal", () => {
    expect(normalizeDeviceId(undefined)).toBeNull();
    expect(normalizeDeviceId("")).toBeNull();
    expect(normalizeDeviceId("not-a-device")).toBeNull();
    expect(normalizeDeviceId("a1b2c3d4e5f6071")).toBeNull();
    expect(normalizeDeviceId(1234)).toBeNull();
  });
});

describe("deviceLabel", () => {
  it("names the app build from x-trajetto-client-version", () => {
    expect(
      deviceLabel({
        "x-trajetto-client-version": "platform=android; version=1.4.0; build=42; contract=3",
        "user-agent": "okhttp/4.12.0",
      }),
    ).toBe("android 1.4.0 (build 42)");
  });

  it("falls back to the User-Agent, bounded, and is null with neither", () => {
    expect(deviceLabel({ "user-agent": "Trajetto/1.3.0 (Android 14)" })).toBe(
      "Trajetto/1.3.0 (Android 14)",
    );
    expect(deviceLabel({ "user-agent": "x".repeat(500) })?.length).toBe(120);
    expect(deviceLabel({})).toBeNull();
  });
});
