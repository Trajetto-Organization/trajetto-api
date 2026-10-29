import "reflect-metadata";

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { uploadConfig } from "@/config/upload";
import { AppError } from "@/shared/errors/AppError";
import {
  R2_CLIENT_TIMEOUTS,
  R2_DEADLINES_MS,
  UploadService,
  createR2Client,
} from "@/shared/services/upload-service";

/**
 * Storage that accepts the connection and never answers.
 *
 * The UploadService built its S3 client with no timeout at all, and in
 * @smithy/node-http-handler 4.x every timeout defaults to 0. The HeadObject
 * that confirms each presigned upload runs inside the HTTP request, so a
 * stuck R2 held that request — and the driver's submission — open for as
 * long as the socket lived. `requestTimeout` alone would not have fixed it:
 * the handler only logs a warning unless `throwOnRequestTimeout` is set.
 *
 * A real HTTP server on loopback stands in for R2: the SDK's own handler,
 * retry loop and abort wiring run unmodified, so what is proven is what
 * production does.
 */
const BUSINESS = "018fe000-0000-7000-8000-00000000000a";
const PHOTO = `odometerPhotos/${BUSINESS}/1727136000000-foto-ab12cd34.jpg`;
const PROOF = `deliveryProofs/${BUSINESS}/proof.pdf`;

let server: Server;
let endpoint = "";

/** Responses held open by the "stuck" routes, ended in afterAll. */
const stuck: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();

    const url = request.url ?? "";

    // A key that does not exist: R2 answers 404.
    if (url.includes("missing")) {
      response.writeHead(404, { "Content-Type": "application/xml" });
      response.end(
        "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
      );
      return;
    }

    // Headers, then a body that stops after a few bytes.
    if (url.includes("trickle")) {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": "1000",
      });
      response.write("%PDF-");
      stuck.push(response);
      return;
    }

    // Everything else: connection accepted, never answered.
    stuck.push(response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const response of stuck) response.destroy();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const credentials = {
  accessKeyId: "AKTEST",
  secretAccessKey: "SKTEST",
};

/** Settles with the elapsed milliseconds and the rejection, if any. */
async function timed(
  work: Promise<unknown>,
): Promise<{ ms: number; error: unknown }> {
  const started = Date.now();

  try {
    await work;
    return { ms: Date.now() - started, error: null };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

describe("the R2 client's own bounds", () => {
  it("are set: connection, request (enforced) and socket timeouts, three attempts", () => {
    expect(R2_CLIENT_TIMEOUTS).toEqual({
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 15_000,
      socketTimeoutMs: 15_000,
      maxAttempts: 3,
    });

    // Every whole-operation deadline sits under the edge's 100 s, and the
    // one on the request path stays short.
    expect(R2_DEADLINES_MS.head).toBeLessThanOrEqual(10_000);
    expect(R2_DEADLINES_MS.transfer).toBeLessThan(100_000);
    expect(R2_DEADLINES_MS.housekeeping).toBeLessThan(100_000);
  });

  it("throw when storage never answers, instead of only warning", async () => {
    const client = createR2Client(
      { ...credentials, endpoint, forcePathStyle: true },
      {
        connectionTimeoutMs: 1_000,
        requestTimeoutMs: 300,
        socketTimeoutMs: 5_000,
        maxAttempts: 1,
      },
    );

    const { ms, error } = await timed(
      client.send(new HeadObjectCommand({ Bucket: "bucket", Key: PHOTO })),
    );

    expect((error as Error | null)?.name).toBe("TimeoutError");
    expect(ms).toBeLessThan(2_000);

    client.destroy();
  });

  it("retry a timeout up to maxAttempts, each attempt bounded", async () => {
    const client = createR2Client(
      { ...credentials, endpoint, forcePathStyle: true },
      {
        connectionTimeoutMs: 1_000,
        requestTimeoutMs: 200,
        socketTimeoutMs: 5_000,
        maxAttempts: 2,
      },
    );

    const { error } = await timed(
      client.send(new HeadObjectCommand({ Bucket: "bucket", Key: PHOTO })),
    );

    expect((error as Error | null)?.name).toBe("TimeoutError");
    expect(
      (error as { $metadata?: { attempts?: number } }).$metadata?.attempts,
    ).toBe(2);

    client.destroy();
  });

  it("still presign without any network call", async () => {
    const service = new UploadService();
    const saved = {
      type: uploadConfig.storage.type,
      bucket: uploadConfig.r2.bucket,
    };

    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "trajetto-test-bucket";

    try {
      (service as unknown as { s3: S3Client }).s3 = createR2Client({
        ...credentials,
        endpoint: "https://account.r2.cloudflarestorage.com",
      });

      const { uploadUrl } = await service.createPresignedUpload(
        { originalFilename: "foto.jpg", contentType: "image/jpeg", size: 10 },
        "odometerPhotos",
        BUSINESS,
      );

      const url = new URL(uploadUrl);

      expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
      expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
        expect.arrayContaining(["content-type", "content-length", "host"]),
      );
    } finally {
      uploadConfig.storage.type = saved.type;
      uploadConfig.r2.bucket = saved.bucket;
    }
  });
});

describe("UploadService against storage that hangs", () => {
  const saved = {
    type: uploadConfig.storage.type,
    bucket: uploadConfig.r2.bucket,
  };

  let service: UploadService;
  let client: S3Client;

  beforeEach(() => {
    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "bucket";

    service = new UploadService();

    // Per-attempt bounds far above the deadlines: what ends each call here
    // is the whole-operation deadline alone.
    client = createR2Client(
      { ...credentials, endpoint, forcePathStyle: true },
      {
        connectionTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        socketTimeoutMs: 10_000,
        maxAttempts: 3,
      },
    );

    Object.assign(service as unknown as Record<string, unknown>, {
      s3: client,
      deadlines: { head: 300, transfer: 300, housekeeping: 300 },
    });
  });

  afterEach(() => {
    uploadConfig.storage.type = saved.type;
    uploadConfig.r2.bucket = saved.bucket;

    client.destroy();
  });

  it("answers an upload confirmation with 503 at its deadline", async () => {
    const { ms, error } = await timed(
      service.headUploadedObject(PHOTO, "odometerPhotos"),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(503);
    expect((error as AppError).code).toBe("STORAGE_UNAVAILABLE");
    expect(ms).toBeLessThan(2_000);
  });

  it("still tells a missing object (400) from storage that is down", async () => {
    const { error } = await timed(
      service.headUploadedObject(
        `odometerPhotos/${BUSINESS}/missing.jpg`,
        "odometerPhotos",
      ),
    );

    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).code).toBe("UPLOADED_FILE_NOT_FOUND");
  });

  it("does not read a stuck object as a missing one", async () => {
    // Null would print "photo missing" into a proof PDF stored for good.
    const { ms, error } = await timed(service.readObject(PROOF));

    expect((error as AppError | null)?.code).toBe("STORAGE_UNAVAILABLE");
    expect(ms).toBeLessThan(2_000);
  });

  it("does not read a body that stopped halfway as a missing object", async () => {
    const { error } = await timed(
      service.readObject(`deliveryProofs/${BUSINESS}/trickle.pdf`),
    );

    expect((error as AppError | null)?.code).toBe("STORAGE_UNAVAILABLE");
  });

  it("answers null for an object that is really gone", async () => {
    expect(
      await service.readObject(`deliveryProofs/${BUSINESS}/missing.pdf`),
    ).toBeNull();
  });

  it("gives up writing a proof PDF at its deadline", async () => {
    const { ms, error } = await timed(
      service.putObject(PROOF, Buffer.from("%PDF-1.7"), "application/pdf"),
    );

    // The same retryable 503 as a read, not the deadline's bare AbortError
    // (a 500 "Internal server error" to the caller).
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(503);
    expect((error as AppError).code).toBe("STORAGE_UNAVAILABLE");
    expect(ms).toBeLessThan(2_000);
  });

  it("reports a stuck delete as not done, without hanging the cleanup", async () => {
    const { ms } = await timed(service.tryDeleteFile(PHOTO));

    expect(await service.tryDeleteFile(PHOTO)).toBe(false);
    expect(ms).toBeLessThan(2_000);
  });
});
