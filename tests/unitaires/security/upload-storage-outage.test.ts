import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UploadService } from "@/shared/services/upload-service";
import { AppError } from "@/shared/errors/AppError";
import { uploadConfig } from "@/config/upload";

const COMPANY = "0198a8d0-70c0-7000-8000-00000000000a";
const KEY = `deliveryPhotos/${COMPANY}/123-proof-abc.webp`;

/**
 * Storage not answering is not the same as the object not being there.
 *
 * This file exists because `headUploadedObject` used to treat them as one. Its
 * `catch` had no binding at all — a 404, a 500 from R2, a DNS failure and a
 * socket timeout all became the same 400 `UPLOADED_FILE_NOT_FOUND`.
 *
 * That 400 is the end of the line for a driver's proof of delivery. The mobile
 * outbox reads a non-transient 4xx as the API refusing on the merits, marks
 * the submission `failed` and never retries it. So a bucket that was briefly
 * unreachable — the most ordinary failure in the whole upload path — silently
 * destroyed a signed receipt that cannot be produced again once the customer
 * has walked away.
 *
 * The contract these tests hold the service to:
 *
 *   object genuinely absent  → 400 UPLOADED_FILE_NOT_FOUND  (final)
 *   anything else            → 503 STORAGE_UNAVAILABLE      (retry)
 *
 * The second line is deliberately the default. Being wrong about an outage
 * costs one retry; being wrong about a missing file costs the proof.
 */

type Send = (command: unknown) => Promise<unknown>;

function serviceTalkingTo(send: Send): UploadService {
  const service = new UploadService();

  // The real client is only built when the config says r2, and building one
  // here would need credentials. What is under test is how the service reads
  // what `send` throws, so a stand-in that throws is the whole fixture.
  (service as unknown as { s3: { send: Send } }).s3 = { send };

  return service;
}

/** An AWS SDK v3 error: a name, and the HTTP status when there was one. */
function awsError(name: string, httpStatusCode?: number): Error {
  const error = new Error(name);
  error.name = name;

  if (httpStatusCode !== undefined) {
    (error as Error & { $metadata?: unknown }).$metadata = { httpStatusCode };
  }

  return error;
}

async function headFailure(send: Send): Promise<AppError> {
  try {
    await serviceTalkingTo(send).headUploadedObject(KEY, "deliveryPhotos");
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error("headUploadedObject resolved when it should have thrown");
}

describe("headUploadedObject: missing object vs. storage outage", () => {
  let originalStorageType: "local" | "r2";

  beforeEach(() => {
    originalStorageType = uploadConfig.storage.type;
    uploadConfig.storage.type = "r2";
  });

  afterEach(() => {
    uploadConfig.storage.type = originalStorageType;
  });

  describe("final — the object is not there", () => {
    it("reports a 404 from storage as a missing file", async () => {
      const error = await headFailure(async () => {
        throw awsError("NotFound", 404);
      });

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("UPLOADED_FILE_NOT_FOUND");
    });

    it("recognises NotFound even when no status came back", async () => {
      // The SDK can raise the typed error without a parsed response; the name
      // is then the only evidence, and it is enough.
      const error = await headFailure(async () => {
        throw awsError("NotFound");
      });

      expect(error.code).toBe("UPLOADED_FILE_NOT_FOUND");
    });

    it("recognises NoSuchKey, which is how a GET words the same thing", async () => {
      const error = await headFailure(async () => {
        throw awsError("NoSuchKey");
      });

      expect(error.code).toBe("UPLOADED_FILE_NOT_FOUND");
    });

    it("trusts a 404 even from something that does not name itself", async () => {
      // Not every 404 arrives as a typed SDK error — a CDN or a proxy in front
      // of the bucket answers with its own body and the SDK surfaces a generic
      // failure carrying only the status. The status is the evidence there,
      // and reading it is what separates this case from an outage.
      const error = await headFailure(async () => {
        throw awsError("Error", 404);
      });

      expect(error.code).toBe("UPLOADED_FILE_NOT_FOUND");
    });
  });

  describe("retryable — storage did not answer", () => {
    /**
     * Every one of these used to produce the 400 above, and every one of them
     * would have thrown away the driver's photo.
     */
    const outages: [label: string, error: unknown][] = [
      ["a 500 from R2", awsError("InternalError", 500)],
      ["a 503 from R2", awsError("ServiceUnavailable", 503)],
      ["a 502 from a proxy in front of it", awsError("BadGateway", 502)],
      ["a request that timed out", awsError("TimeoutError")],
      [
        "a socket hang-up",
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      ],
      [
        "DNS that did not resolve",
        Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
      ],
      [
        "a refused connection",
        Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      ],
      [
        "credentials the SDK could not load",
        awsError("CredentialsProviderError"),
      ],
      ["something nobody recognises", "a string, thrown"],
    ];

    it.each(outages)("retries after %s", async (_label, thrown) => {
      const error = await headFailure(async () => {
        throw thrown;
      });

      expect(error.statusCode).toBe(503);
      expect(error.code).toBe("STORAGE_UNAVAILABLE");
    });

    it("answers at or above 500, which is what makes every client retry", async () => {
      // Stated as its own assertion because the number is the contract. The
      // mobile outbox treats `status >= 500` as transient and keeps the item
      // pending; the web query client retries on the same rule. Dropping this
      // to a 4xx would restore the original bug without touching the branch.
      const error = await headFailure(async () => {
        throw awsError("InternalError", 500);
      });

      expect(error.statusCode).toBeGreaterThanOrEqual(500);
    });
  });

  describe("the object is there", () => {
    it("returns what storage reported", async () => {
      const service = serviceTalkingTo(async () => ({
        ContentLength: 2048,
        ContentType: "image/webp",
      }));

      await expect(
        service.headUploadedObject(KEY, "deliveryPhotos"),
      ).resolves.toEqual({ size: 2048, contentType: "image/webp" });
    });

    it("still refuses an object that answers but breaks the rules", async () => {
      // The outage branch must not have swallowed the limit checks: an object
      // that exists and is 400 MB is a final refusal, not a retry.
      const service = serviceTalkingTo(async () => ({
        ContentLength: 400 * 1024 * 1024,
        ContentType: "image/webp",
      }));

      await expect(
        service.headUploadedObject(KEY, "deliveryPhotos"),
      ).rejects.toMatchObject({ statusCode: 400, code: "FILE_TOO_LARGE" });
    });
  });

  describe("local storage, same distinction", () => {
    beforeEach(() => {
      uploadConfig.storage.type = "local";
    });

    it("reports ENOENT as a missing file", async () => {
      const service = new UploadService();

      await expect(
        service.headUploadedObject(
          `deliveryPhotos/${COMPANY}/nao-existe.webp`,
          "deliveryPhotos",
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "UPLOADED_FILE_NOT_FOUND",
      });
    });

    it("reports anything else from the filesystem as retryable", async () => {
      const service = new UploadService();

      // A NUL byte makes `stat` reject before it ever touches the disk, with
      // a code that is emphatically not ENOENT. It stands in for the family
      // this branch is really about — EACCES, EIO, EMFILE, a volume that went
      // away — none of which mean the upload did not happen.
      await expect(
        service.headUploadedObject(
          `deliveryPhotos/${COMPANY}/nul\u0000byte.webp`,
          "deliveryPhotos",
        ),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    });
  });
});
