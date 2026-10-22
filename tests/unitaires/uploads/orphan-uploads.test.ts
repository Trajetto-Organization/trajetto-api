import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { UPLOAD_TYPES, uploadConfig } from "@/config/upload";

/**
 * Which stored objects the orphan collector may even look at.
 *
 * An object lands in the bucket through a presigned PUT and becomes a row
 * only when the client submits. Abandoned forms, refused heads and deletes
 * that failed leave objects nothing points at, and nothing ever collected
 * them. ADR 0006 still holds — an object belongs to the client's retry until
 * the record exists — so the collector is narrow by construction:
 *
 *   - only keys whose name carries the upload's own timestamp (the presigned
 *     format); any other shape is legacy and never touched;
 *   - only objects between 30 and 33 days old: past any realistic retry, and
 *     three nightly chances per object, so a missed night loses nothing;
 *   - every client-written namespace must be classified, and the
 *     server-written one (proof PDFs) is never scanned.
 */
const BUSINESS = "018fe000-0000-7000-8000-00000000000a";

const DAY = 24 * 60 * 60 * 1000;

async function load() {
  return import("@/shared/services/orphan-uploads");
}

describe("keyTimestamp", () => {
  it("reads the upload time a presigned key was generated with", async () => {
    const { keyTimestamp } = await load();

    expect(
      keyTimestamp(
        `odometerPhotos/${BUSINESS}/1727136000000-foto-ab12cd34.jpg`,
      ),
    ).toBe(1727136000000);
  });

  it.each([
    [`odometerPhotos/${BUSINESS}/legacy.jpg`],
    ["odometerPhotos/1727136000000-foto-ab12cd34.webp"],
    [`odometerPhotos/${BUSINESS}/172713600000-short.jpg`],
    [`odometerPhotos/${BUSINESS}/sub/1727136000000-x.jpg`],
    [""],
  ])("refuses any other shape: %s", async (key) => {
    const { keyTimestamp } = await load();

    expect(keyTimestamp(key)).toBeNull();
  });
});

describe("the collection window", () => {
  const now = Date.UTC(2026, 8, 24, 4, 50);

  it("spans the objects 30 to 33 days old", async () => {
    const { orphanWindow } = await load();

    const window = orphanWindow(now);

    expect(window.endMs).toBe(now - 30 * DAY);
    expect(window.startMs).toBe(now - 33 * DAY);
  });

  it("bounds a scope's keys by string range, the way the bucket lists them", async () => {
    const { orphanWindow, keyRange, keyTimestamp } = await load();

    const window = orphanWindow(now);
    const prefix = `deliveryPhotos/${BUSINESS}/`;
    const { lo, hi } = keyRange(prefix, window);

    const inside = [
      `${prefix}${window.startMs}-a-00000000.jpg`,
      `${prefix}${now - 31 * DAY}-b-11111111.jpg`,
      `${prefix}${window.endMs}-c-22222222.jpg`,
    ];

    const outside = [
      `${prefix}${window.startMs - 1}-too-old-00000000.jpg`,
      `${prefix}${window.endMs + 1}-too-young-00000000.jpg`,
      `${prefix}${now - DAY}-yesterday-00000000.jpg`,
    ];

    for (const key of inside) {
      expect(key >= lo && key < hi, key).toBe(true);
      expect(keyTimestamp(key)).not.toBeNull();
    }

    for (const key of outside) {
      expect(key >= lo && key < hi, key).toBe(false);
    }
  });
});

describe("how it is switched on", () => {
  const base = {
    NODE_ENV: "development",
    REDIS_URL: "redis://redis:6379",
    HTTP_REQUEST: "https://app.example.com",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  it("only counts unless somebody asks it to delete", async () => {
    const { envSchema } = await import("@/schemas/env-schema");

    expect(envSchema.parse(base).UPLOAD_ORPHAN_GC).toBe("dry-run");
    expect(
      envSchema.parse({ ...base, UPLOAD_ORPHAN_GC: "" }).UPLOAD_ORPHAN_GC,
    ).toBe("dry-run");
    expect(
      envSchema.safeParse({ ...base, UPLOAD_ORPHAN_GC: "yes" }).success,
    ).toBe(false);
  });

  it("runs every night as a registered cron job", async () => {
    const { cleanupOrphanUploadsJob } = await import(
      "@/jobs/cron/cleanup-orphan-uploads-job"
    );

    const source = readFileSync(
      resolve(__dirname, "../../../src/jobs/cron/index.ts"),
      "utf8",
    );

    expect(cleanupOrphanUploadsJob.schedule).toBe("50 4 * * *");
    expect(source).toContain("scheduler.registerJob(cleanupOrphanUploadsJob)");
  });
});

describe("the namespaces it scans", () => {
  it("classifies every client-written upload type, and never the server-written one", async () => {
    const { ORPHAN_GC_NAMESPACES } = await load();

    const clientWritten = UPLOAD_TYPES.filter(
      (type) => !uploadConfig.serverOnlyUploadTypes.includes(type),
    );

    expect(Object.keys(ORPHAN_GC_NAMESPACES).sort()).toEqual(
      [...clientWritten].sort(),
    );

    expect(Object.keys(ORPHAN_GC_NAMESPACES)).not.toContain("deliveryProofs");
  });
});
