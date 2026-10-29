import "reflect-metadata";

import { S3Client } from "@aws-sdk/client-s3";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadConfig } from "@/config/upload";
import { UploadService } from "@/shared/services/upload-service";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * A storage delete that fails, and who finds out.
 *
 * `deleteFile` is deliberately non-throwing — its callers are cleaning up
 * after something else and must not fail because the cleanup did. But it
 * swallowed EVERY failure with a log line that did not even name the object,
 * so a delete that failed became an orphan nobody could find, and the caller
 * could not tell it apart from one that worked.
 *
 * It now answers whether the object is gone, and a failure names the key.
 */
const KEY =
  "odometerPhotos/018fe000-0000-7000-8000-00000000000a/1727136000000-foto-ab12cd34.jpg";

describe("deleting from R2", () => {
  const saved = {
    type: uploadConfig.storage.type,
    bucket: uploadConfig.r2.bucket,
  };

  let service: UploadService;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    uploadConfig.storage.type = "r2";
    uploadConfig.r2.bucket = "trajetto-test-bucket";

    service = new UploadService();
    send = vi.fn();

    (service as unknown as { s3: Pick<S3Client, "send"> }).s3 = {
      send,
    } as unknown as S3Client;

    clearLogged();
  });

  afterEach(() => {
    uploadConfig.storage.type = saved.type;
    uploadConfig.r2.bucket = saved.bucket;

    vi.restoreAllMocks();
  });

  // Each error line as the JSON the log shipper receives.
  const loggedLines = () => logged("error").map((line) => JSON.stringify(line));

  it("answers false when storage refuses, and names the key in the log", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("AccessDenied: object is locked"), {
        name: "AccessDenied",
      }),
    );

    const deleted = await service.tryDeleteFile(KEY);

    expect(deleted).toBe(false);
    expect(loggedLines().some((line) => line.includes(KEY))).toBe(true);
  });

  it("answers true when the object is gone", async () => {
    send.mockResolvedValue({});

    await expect(service.tryDeleteFile(KEY)).resolves.toBe(true);
  });

  it("still never throws, whatever storage does", async () => {
    send.mockRejectedValue(new Error("socket hang up"));

    await expect(service.tryDeleteFile(KEY)).resolves.toBe(false);
  });

  it("names the key for the callers that only clean up, too", async () => {
    // deleteFile is what every use case calls; before, its log line said
    // "Erro ao deletar arquivo" and nothing about which one.
    send.mockRejectedValue(new Error("socket hang up"));

    await expect(service.deleteFile(KEY)).resolves.toBeUndefined();
    expect(loggedLines().some((line) => line.includes(KEY))).toBe(true);
  });
});
