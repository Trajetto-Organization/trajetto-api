import "reflect-metadata";

import { S3Client } from "@aws-sdk/client-s3";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uploadConfig } from "@/config/upload";
import { UploadService } from "@/shared/services/upload-service";

/**
 * What the presigned PUT actually binds the client to.
 *
 * The comments on the upload flow promised that `ContentType` and
 * `ContentLength` are signed headers, so storage refuses a PUT whose type or
 * size differs from what was authorised. Only the size was true:
 * `@aws-sdk/s3-request-presigner` adds `content-type` to its unsignable set on
 * every presign, and the URL came out with `X-Amz-SignedHeaders=content-length;host`.
 * A client could presign `image/jpeg` and PUT `text/html`, and R2 accepted it.
 * Development (local token) already enforced the type; production did not.
 *
 * getSignedUrl signs locally — no request leaves the process — so a fake
 * account and fake credentials are enough to read the signed header list.
 */
const BUSINESS = "018fe000-0000-7000-8000-00000000000a";

describe("the presigned PUT signature (R2)", () => {
  const saved = {
    type: uploadConfig.storage.type,
    bucket: uploadConfig.r2.bucket,
  };

  let service: UploadService;

  beforeEach(() => {
    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "trajetto-test-bucket";

    service = new UploadService();

    (service as unknown as { s3: S3Client }).s3 = new S3Client({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    });
  });

  afterEach(() => {
    uploadConfig.storage.type = saved.type;
    uploadConfig.r2.bucket = saved.bucket;
  });

  const signedHeaders = async (contentType: string, uploadType = "odometerPhotos" as const) => {
    const { uploadUrl } = await service.createPresignedUpload(
      { originalFilename: "foto.jpg", contentType, size: 1000 },
      uploadType,
      BUSINESS,
    );

    return (
      new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? ""
    ).split(";");
  };

  it("signs Content-Type, so storage refuses a PUT of another type", async () => {
    expect(await signedHeaders("image/jpeg")).toContain("content-type");
  });

  it("still signs Content-Length, so storage enforces the size", async () => {
    expect(await signedHeaders("image/png")).toContain("content-length");
  });

  it("signs the type of a voice note too", async () => {
    const { uploadUrl } = await service.createPresignedUpload(
      { originalFilename: "nota.m4a", contentType: "audio/mp4", size: 1000 },
      "chatAttachments",
      BUSINESS,
    );

    expect(
      new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders")?.split(";"),
    ).toContain("content-type");
  });

  it("does not move the type into the query string, where a client could drop it", async () => {
    const { uploadUrl } = await service.createPresignedUpload(
      { originalFilename: "foto.jpg", contentType: "image/jpeg", size: 1000 },
      "odometerPhotos",
      BUSINESS,
    );

    const params = [...new URL(uploadUrl).searchParams.keys()].map((name) =>
      name.toLowerCase(),
    );

    expect(params).not.toContain("content-type");
  });
});
