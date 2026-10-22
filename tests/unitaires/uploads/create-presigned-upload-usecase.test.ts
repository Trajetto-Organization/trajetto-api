import "reflect-metadata";

import { S3Client } from "@aws-sdk/client-s3";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uploadConfig } from "@/config/upload";
import { UploadService } from "@/shared/services/upload-service";

import { CreatePresignedUploadUseCase } from "@/modules/upload/usecases/create-presigned-upload/create-presigned-upload-usecase";

/**
 * The batch presign (TEST-UC-1) over the real UploadService. getSignedUrl
 * signs locally (no request leaves the process), so fake credentials are
 * enough. What is proven is the batch: one URL per file under the caller's
 * scope, and one bad file refusing the whole batch before any URL is given.
 */
const BUSINESS = "018f3600-0000-7000-8000-00000000000a";

describe("presigning a batch of uploads", () => {
  const saved = {
    type: uploadConfig.storage.type,
    bucket: uploadConfig.r2.bucket,
  };

  let useCase: CreatePresignedUploadUseCase;

  beforeEach(() => {
    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "trajetto-test-bucket";

    const service = new UploadService();

    (service as unknown as { s3: S3Client }).s3 = new S3Client({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    });

    useCase = new CreatePresignedUploadUseCase(service);
  });

  afterEach(() => {
    uploadConfig.storage.type = saved.type;
    uploadConfig.r2.bucket = saved.bucket;
  });

  const photo = (name: string) => ({
    originalFilename: name,
    contentType: "image/jpeg",
    size: 2_000,
  });

  it("hands one signed PUT per file, each under the caller's scope and with its own key", async () => {
    const result = await useCase.execute({
      uploadType: "odometerPhotos",
      scopeId: BUSINESS,
      files: [photo("painel-1.jpg"), photo("painel-2.jpg")],
    });

    expect(result).toHaveLength(2);
    expect(new Set(result.map((entry) => entry.key)).size).toBe(2);

    for (const entry of result) {
      expect(entry.key).toContain(BUSINESS);
      expect(entry.uploadUrl).toContain("X-Amz-Signature=");
      expect(entry.expiresIn).toBeGreaterThan(0);
    }
  });

  it("refuses the whole batch when one file has a type the upload does not accept", async () => {
    await expect(
      useCase.execute({
        uploadType: "odometerPhotos",
        scopeId: BUSINESS,
        files: [
          photo("painel.jpg"),
          {
            originalFilename: "pagina.html",
            contentType: "text/html",
            size: 100,
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "UNSUPPORTED_FILE_TYPE" });
  });

  it("refuses an empty or oversized file", async () => {
    await expect(
      useCase.execute({
        uploadType: "odometerPhotos",
        scopeId: BUSINESS,
        files: [{ ...photo("vazia.jpg"), size: 0 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      useCase.execute({
        uploadType: "odometerPhotos",
        scopeId: BUSINESS,
        files: [{ ...photo("enorme.jpg"), size: 500 * 1024 * 1024 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("never signs a namespace only the server writes (403)", async () => {
    await expect(
      useCase.execute({
        uploadType: "deliveryProofs",
        scopeId: BUSINESS,
        files: [
          {
            originalFilename: "c.pdf",
            contentType: "application/pdf",
            size: 100,
          },
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SERVER_ONLY_UPLOAD_TYPE",
    });
  });
});
