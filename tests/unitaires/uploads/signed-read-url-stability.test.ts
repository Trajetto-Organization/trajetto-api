import "reflect-metadata";

import { S3Client } from "@aws-sdk/client-s3";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadConfig } from "@/config/upload";
import { UploadService } from "@/shared/services/upload-service";

/**
 * The read URL of an object, asked for twice.
 *
 * Every `/user/me` signed the avatar again with the real clock, so the URL
 * changed on each call. The web re-reads the profile after a 2FA or password
 * change, and the avatar flashed the initials while the same photo downloaded
 * again under a URL the browser had never cached.
 *
 * getSignedUrl signs locally — fake credentials are enough.
 */
const KEY = "avatars/018fe000-0000-7000-8000-00000000000a/foto.jpg";

describe("the signed read URL (R2)", () => {
  const saved = {
    type: uploadConfig.storage.type,
    bucket: uploadConfig.r2.bucket,
    ttl: uploadConfig.signedUrlTtlSeconds,
  };

  let service: UploadService;

  beforeEach(() => {
    vi.useFakeTimers();
    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "trajetto-test-bucket";
    uploadConfig.signedUrlTtlSeconds = 900;

    service = new UploadService();

    (service as unknown as { s3: S3Client }).s3 = new S3Client({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    uploadConfig.storage.type = saved.type;
    uploadConfig.r2.bucket = saved.bucket;
    uploadConfig.signedUrlTtlSeconds = saved.ttl;
  });

  const signedAt = (url: string) => {
    const amzDate = new URL(url).searchParams.get("X-Amz-Date") ?? "";
    const iso = amzDate.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    );

    return new Date(iso).getTime();
  };

  it("is the same URL for two reads a few minutes apart", async () => {
    vi.setSystemTime(new Date("2026-10-28T12:00:10Z"));
    const first = await service.getFileUrl(KEY);

    vi.setSystemTime(new Date("2026-10-28T12:07:00Z"));
    const second = await service.getFileUrl(KEY);

    expect(second).toBe(first);
  });

  it("moves to a new URL in the next half-TTL window", async () => {
    vi.setSystemTime(new Date("2026-10-28T12:07:29Z"));
    const before = await service.getFileUrl(KEY);

    vi.setSystemTime(new Date("2026-10-28T12:07:31Z"));
    const after = await service.getFileUrl(KEY);

    expect(after).not.toBe(before);
  });

  it("never lives longer than the TTL and leaves at least half of it", async () => {
    const now = new Date("2026-10-28T12:14:59Z").getTime();
    vi.setSystemTime(now);

    const url = await service.getFileUrl(KEY);
    const expiresIn = Number(new URL(url).searchParams.get("X-Amz-Expires"));
    const expiresAt = signedAt(url) + expiresIn * 1000;

    expect(expiresIn).toBe(900);
    expect(signedAt(url)).toBeLessThanOrEqual(now);
    expect(expiresAt - now).toBeGreaterThanOrEqual(450_000);
  });
});
