import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import type { UploadService as UploadServiceType } from "@/shared/services/upload-service";

/**
 * TEST-UP-1: the real upload path, end to end, against an S3-compatible
 * server (MinIO, `tests/support/minio/minio-test.sh`), with the real
 * UploadService and the real S3 client — nothing mocked:
 *
 *   presign (API) → PUT of the bytes (client) → object in the bucket →
 *   resolvePresignedUploads (API: prefix, existence, type, size) →
 *   signed GET returns the same bytes.
 *
 * Every other E2E replaces the UploadService (whole-flow and eight more), so
 * until this file nothing proved that a URL the API signs is one storage
 * accepts, nor that the HEAD the API trusts reads what the PUT wrote.
 *
 * Runs only when MINIO_TEST_ENDPOINT/ACCESS_KEY/SECRET_KEY are set (the
 * script's `env` prints them); without them it is skipped, loudly. With
 * REQUIRE_MINIO=1 (CI) a missing setup FAILS instead: a skipped round trip
 * there would let a storage regression pass unnoticed.
 */
const endpoint = process.env.MINIO_TEST_ENDPOINT;
const accessKeyId = process.env.MINIO_TEST_ACCESS_KEY;
const secretAccessKey = process.env.MINIO_TEST_SECRET_KEY;

const configured = Boolean(endpoint && accessKeyId && secretAccessKey);

if (!configured && process.env.REQUIRE_MINIO === "1") {
  throw new Error(
    "upload-storage-roundtrip: REQUIRE_MINIO=1 but MINIO_TEST_ENDPOINT/ACCESS_KEY/SECRET_KEY are not set (bash tests/support/minio/minio-test.sh start && eval \"$(bash tests/support/minio/minio-test.sh env)\")",
  );
}

if (!configured) {
  console.warn(
    'upload-storage-roundtrip: MINIO_TEST_* not set, skipped (bash tests/support/minio/minio-test.sh start && eval "$(bash tests/support/minio/minio-test.sh env)")',
  );
}

const BUCKET = `trajetto-e2e-${randomUUID().slice(0, 8)}`;
const BUSINESS = randomUUID();
const OTHER_BUSINESS = randomUUID();
const USER = randomUUID();

// A real (tiny) PNG, JPEG, M4A header and PDF: what lands is compared byte for byte.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const JPEG = Buffer.concat([
  Buffer.from("ffd8ffe000104a46494600", "hex"),
  Buffer.alloc(64, 7),
  Buffer.from("ffd9", "hex"),
]);
const M4A = Buffer.concat([
  Buffer.from("0000001c667479704d344120", "hex"),
  Buffer.alloc(128, 1),
]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const admin = configured
  ? new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    })
  : null;

let uploads: UploadServiceType;

async function put(
  url: string,
  body: Buffer,
  contentType: string,
): Promise<number> {
  const response = await fetch(url, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
    },
  });

  return response.status;
}

async function presignAndPut(
  type: "avatars" | "deliveryPhotos" | "chatAttachments",
  scopeId: string,
  file: { name: string; contentType: string; body: Buffer },
): Promise<string> {
  const { key, uploadUrl } = await uploads.createPresignedUpload(
    {
      originalFilename: file.name,
      contentType: file.contentType,
      size: file.body.length,
    },
    type,
    scopeId,
  );

  expect(new URL(uploadUrl).origin).toBe(new URL(endpoint!).origin);
  expect(await put(uploadUrl, file.body, file.contentType)).toBe(200);

  return key;
}

async function download(
  key: string,
): Promise<{ status: number; type: string | null; body: Buffer }> {
  const response = await fetch(await uploads.getFileUrl(key));

  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

describe.skipIf(!configured)("uploads against S3-compatible storage", () => {
  beforeAll(async () => {
    // Before the first import of @/env: the service reads its storage at load.
    process.env.UPLOAD_STORAGE_TYPE = "r2";
    process.env.R2_ENDPOINT = endpoint;
    process.env.R2_ACCOUNT_ID = "local-minio";
    process.env.R2_BUCKET_NAME = BUCKET;
    process.env.R2_ACCESS_KEY_ID = accessKeyId;
    process.env.R2_SECRET_ACCESS_KEY = secretAccessKey;

    await admin!.send(new CreateBucketCommand({ Bucket: BUCKET }));

    const { UploadService } = await import("@/shared/services/upload-service");
    uploads = new UploadService();
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;

    const listed = await admin.send(
      new ListObjectsV2Command({ Bucket: BUCKET }),
    );

    for (const object of listed.Contents ?? []) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: object.Key! }),
      );
    }

    await admin.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    admin.destroy();
  });

  it("an avatar: presign, PUT, resolve, and read back the same bytes", async () => {
    const key = await presignAndPut("avatars", USER, {
      name: "Foto de perfil.PNG",
      contentType: "image/png",
      body: PNG,
    });

    expect(key).toMatch(
      new RegExp(`^avatars/${USER}/\\d+-foto-de-perfil-[0-9a-f]{8}\\.png$`),
    );
    expect(
      await uploads.resolvePresignedUploads([{ key }], "avatars", USER),
    ).toEqual([{ path: key, fieldName: undefined }]);

    const read = await download(key);
    expect(read.status).toBe(200);
    expect(read.type).toBe("image/png");
    expect(read.body.equals(PNG)).toBe(true);
  });

  it("a proof or occurrence photo: resolved under the company's prefix, with the field it fills", async () => {
    const key = await presignAndPut("deliveryPhotos", BUSINESS, {
      name: "canhoto.jpg",
      contentType: "image/jpeg",
      body: JPEG,
    });

    expect(
      await uploads.resolvePresignedUploads(
        [{ key, fieldName: "photo" }],
        "deliveryPhotos",
        BUSINESS,
      ),
    ).toEqual([{ path: key, fieldName: "photo" }]);
    expect((await uploads.headUploadedObject(key, "deliveryPhotos")).size).toBe(
      JPEG.length,
    );
    expect((await download(key)).body.equals(JPEG)).toBe(true);
  });

  it("a chat voice note keeps its audio type and extension", async () => {
    const key = await presignAndPut("chatAttachments", BUSINESS, {
      name: "nota.m4a",
      contentType: "audio/mp4",
      body: M4A,
    });

    expect(key.endsWith(".m4a")).toBe(true);
    expect(await uploads.headUploadedObject(key, "chatAttachments")).toEqual({
      size: M4A.length,
      contentType: "audio/mp4",
    });
    expect((await download(key)).type).toBe("audio/mp4");
  });

  it("a proof document: written by the server only, read back intact", async () => {
    await expect(
      uploads.createPresignedUpload(
        {
          originalFilename: "comprovante.pdf",
          contentType: "application/pdf",
          size: PDF.length,
        },
        "deliveryProofs",
        BUSINESS,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SERVER_ONLY_UPLOAD_TYPE",
    });

    const key = `deliveryProofs/${BUSINESS}/${randomUUID()}.pdf`;
    await uploads.putObject(key, PDF, "application/pdf");

    expect((await uploads.readObject(key))?.equals(PDF)).toBe(true);
    expect((await download(key)).type).toBe("application/pdf");
    expect(
      await uploads.readObject(`deliveryProofs/${BUSINESS}/missing.pdf`),
    ).toBeNull();
  });

  describe("what storage or the API refuses", () => {
    it("a PUT under another content type than the one signed", async () => {
      const { key, uploadUrl } = await uploads.createPresignedUpload(
        {
          originalFilename: "x.png",
          contentType: "image/png",
          size: PNG.length,
        },
        "avatars",
        USER,
      );

      expect(await put(uploadUrl, PNG, "text/html")).toBe(403);
      await expect(
        uploads.resolvePresignedUploads([{ key }], "avatars", USER),
      ).rejects.toMatchObject({
        code: "UPLOADED_FILE_NOT_FOUND",
      });
    });

    it("a PUT of more bytes than the size signed", async () => {
      const { uploadUrl } = await uploads.createPresignedUpload(
        { originalFilename: "x.jpg", contentType: "image/jpeg", size: 10 },
        "deliveryPhotos",
        BUSINESS,
      );

      expect(await put(uploadUrl, JPEG, "image/jpeg")).not.toBe(200);
    });

    it("a key that was signed but never uploaded", async () => {
      const { key } = await uploads.createPresignedUpload(
        {
          originalFilename: "x.jpg",
          contentType: "image/jpeg",
          size: JPEG.length,
        },
        "deliveryPhotos",
        BUSINESS,
      );

      await expect(
        uploads.resolvePresignedUploads([{ key }], "deliveryPhotos", BUSINESS),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "UPLOADED_FILE_NOT_FOUND",
      });
    });

    it("another company's key, even one that exists", async () => {
      const key = await presignAndPut("deliveryPhotos", OTHER_BUSINESS, {
        name: "alheio.jpg",
        contentType: "image/jpeg",
        body: JPEG,
      });

      await expect(
        uploads.resolvePresignedUploads([{ key }], "deliveryPhotos", BUSINESS),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "UPLOAD_KEY_FORBIDDEN",
      });
    });

    it("an object whose stored type is not allowed for the namespace", async () => {
      // Written straight to the bucket, as a client with a leaked key could.
      const key = `deliveryPhotos/${BUSINESS}/${randomUUID()}.jpg`;
      await uploads.putObject(key, PDF, "application/pdf");

      await expect(
        uploads.resolvePresignedUploads([{ key }], "deliveryPhotos", BUSINESS),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "UNSUPPORTED_FILE_TYPE",
      });
    });
  });
});
