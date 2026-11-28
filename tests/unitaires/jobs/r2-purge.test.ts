import { describe, expect, it } from "vitest";

import { UPLOAD_TYPES } from "@/config/upload";
import {
  TENANT_STORAGE_SOURCES,
  freshStorageCursor,
  purgeStoragePage,
  type PurgeObjectStorage,
  type StorageCursor,
} from "@/shared/jobs/tenant-offboard/r2-purge";
import type { StorageDeleteOutcome } from "@/shared/services/upload-service";

/**
 * The purge of a company's objects in the uploads bucket (plano-escala
 * F3-26b), page by page.
 *
 * A namespace added to UPLOAD_TYPES without saying how its keys name their
 * owner would outlive every company's purge, so the sources must cover all
 * of them. An object the bucket's lock holds is retained and counted — the
 * job goes on — while any other failure fails the page, for the job's
 * retry; and the listing moves past what it saw, so a locked object never
 * loops the purge. The query for the owners is the E2E's
 * (tests/E2E/tenant-offboard.test.ts); here they come from a stub.
 */

const COMPANY = "018fe000-0000-7000-8000-00000000000a";

class FakeBucket implements PurgeObjectStorage {
  readonly objects = new Set<string>();
  readonly locked = new Set<string>();
  readonly failing = new Set<string>();
  listings = 0;

  async listObjectKeys(prefix: string, startAfter?: string, maxKeys = 1000) {
    this.listings += 1;

    return [...this.objects]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => startAfter === undefined || key > startAfter)
      .sort()
      .slice(0, maxKeys);
  }

  async deleteFileOutcome(key: string): Promise<StorageDeleteOutcome> {
    if (this.failing.has(key)) return "failed";
    if (this.locked.has(key)) return "locked";

    this.objects.delete(key);

    return "deleted";
  }
}

function ownersStub(users: string[], deliveries: string[]) {
  return {
    async $queryRaw(query: TemplateStringsArray, ...values: unknown[]) {
      const after = String(values[1] ?? "");
      const pool = query.join("?").includes('"user"') ? users : deliveries;

      return pool.filter((id) => id > after).map((id) => ({ id }));
    },
  } as never;
}

async function purgeAll(
  bucket: FakeBucket,
  users: string[] = [],
  deliveries: string[] = [],
  pageSize = 2,
): Promise<StorageCursor> {
  const deps = { db: ownersStub(users, deliveries), storage: bucket, pageSize };
  let cursor = freshStorageCursor();

  for (let pages = 0; pages < 100; pages += 1) {
    const next = await purgeStoragePage(deps, COMPANY, cursor);

    if (next === null) return cursor;

    cursor = next;
  }

  throw new Error("the purge of the bucket never ended");
}

describe("the purge of a company's objects", () => {
  it("knows how every upload namespace names its owner", () => {
    expect(
      [...new Set(TENANT_STORAGE_SOURCES.map((source) => source.type))].sort(),
    ).toEqual([...UPLOAD_TYPES].sort());
  });

  it("deletes every object of the company's prefixes, page by page, and nobody else's", async () => {
    const bucket = new FakeBucket();
    const other = "018fe000-0000-7000-8000-00000000000b";

    for (const name of ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"]) {
      bucket.objects.add(`odometerPhotos/${COMPANY}/${name}`);
    }
    bucket.objects.add(`chatAttachments/${COMPANY}/audio.m4a`);
    bucket.objects.add(`avatars/user-1/me.jpg`);
    bucket.objects.add(`avatars/user-2/me.jpg`);
    bucket.objects.add(`deliveryProofs/delivery-1/abc.pdf`);
    bucket.objects.add(`odometerPhotos/${other}/1.jpg`);
    bucket.objects.add(`avatars/user-9/me.jpg`);

    const cursor = await purgeAll(bucket, ["user-1", "user-2"], ["delivery-1"]);

    expect([...bucket.objects].sort()).toEqual([
      "avatars/user-9/me.jpg",
      `odometerPhotos/${other}/1.jpg`,
    ]);
    expect(cursor).toMatchObject({ deleted: 9, retained: 0 });
  });

  it("retains what a lock holds, counts it and goes on", async () => {
    const bucket = new FakeBucket();

    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
      bucket.objects.add(`deliveryProofs/delivery-1/${name}`);
      bucket.locked.add(`deliveryProofs/delivery-1/${name}`);
    }
    bucket.objects.add(`deliveryProofs/delivery-2/old.pdf`);

    const cursor = await purgeAll(bucket, [], ["delivery-1", "delivery-2"]);

    expect(cursor).toMatchObject({ deleted: 1, retained: 3 });
    expect([...bucket.objects].sort()).toEqual([
      "deliveryProofs/delivery-1/a.pdf",
      "deliveryProofs/delivery-1/b.pdf",
      "deliveryProofs/delivery-1/c.pdf",
    ]);
  });

  it("fails the page on any other failure, for the job's retry to resume it", async () => {
    const bucket = new FakeBucket();

    bucket.objects.add(`deliveryPhotos/${COMPANY}/1.jpg`);
    bucket.failing.add(`deliveryPhotos/${COMPANY}/1.jpg`);

    await expect(purgeAll(bucket)).rejects.toThrow(/não puderam ser apagados/);
  });
});
