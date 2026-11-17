import { describe, expect, it } from "vitest";

import {
  ARCHIVE_CONTENT_TYPE,
  createS3ArchiveStorage,
} from "@/shared/archive/archive-storage";
import { missingArchiveSettings } from "@/shared/archive/archive-settings";

/**
 * The archive bucket's writer (plano-escala F2-11), against a client that
 * records what it is asked.
 *
 * Why each case: R2 refuses a multipart upload whose parts (all but the
 * last) differ in size, and the gzip hands out chunks of any size, so the
 * parts must be cut at exactly the part size; an upload that fails
 * half-way must be aborted, or its parts stay billed and the object key
 * holds nothing; a day of a small company is one PutObject, not three
 * calls; and both paths must carry the storage class the environment
 * chose, or the archive lands in the dearer class.
 */
interface Sent {
  command: string;
  input: Record<string, unknown>;
}

function recordingClient(options: { failOnPart?: number } = {}) {
  const sent: Sent[] = [];
  let parts = 0;

  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name;

      sent.push({ command: name, input: command.input });

      if (name === "CreateMultipartUploadCommand") return { UploadId: "u-1" };

      if (name === "UploadPartCommand") {
        parts += 1;

        if (options.failOnPart === parts) {
          throw new Error("R2 indisponível");
        }

        return { ETag: `"etag-${parts}"` };
      }

      return {};
    },
  };

  return { client: client as never, sent };
}

async function* chunks(...sizes: number[]): AsyncGenerator<Uint8Array> {
  let byte = 0;

  for (const size of sizes) {
    yield Buffer.alloc(size, byte % 256);
    byte += 1;
  }
}

const bodyLength = (input: Record<string, unknown>) =>
  (input.Body as Buffer).length;

describe("the S3 archive storage", () => {
  it("cuts a multipart upload into parts of exactly the part size, the last one smaller", async () => {
    const { client, sent } = recordingClient();
    const storage = createS3ArchiveStorage({
      client,
      bucket: "trajetto-archive-test",
      storageClass: "STANDARD_IA",
      partSize: 10,
    });

    // 7 + 7 + 7 + 4 = 25 bytes: parts of 10, 10 and 5.
    await storage.put("trail/20261001/b.csv.gz", chunks(7, 7, 7, 4));

    const commands = sent.map((each) => each.command);

    expect(commands).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
    ]);

    const uploaded = sent.filter(
      (each) => each.command === "UploadPartCommand",
    );

    expect(uploaded.map((each) => bodyLength(each.input))).toEqual([10, 10, 5]);
    expect(uploaded.map((each) => each.input.PartNumber)).toEqual([1, 2, 3]);

    expect(sent[0].input).toMatchObject({
      Bucket: "trajetto-archive-test",
      Key: "trail/20261001/b.csv.gz",
      StorageClass: "STANDARD_IA",
      ContentType: ARCHIVE_CONTENT_TYPE,
    });
    expect(sent[4].input).toMatchObject({
      UploadId: "u-1",
      MultipartUpload: {
        Parts: [
          { ETag: '"etag-1"', PartNumber: 1 },
          { ETag: '"etag-2"', PartNumber: 2 },
          { ETag: '"etag-3"', PartNumber: 3 },
        ],
      },
    });
  });

  it("keeps the bytes in order across the cuts", async () => {
    const { client, sent } = recordingClient();
    const storage = createS3ArchiveStorage({
      client,
      bucket: "b",
      storageClass: "STANDARD",
      partSize: 4,
    });

    const body = Buffer.from("abcdefghijk");

    await storage.put(
      "k",
      (async function* () {
        yield body.subarray(0, 3);
        yield body.subarray(3, 9);
        yield body.subarray(9);
      })(),
    );

    const joined = Buffer.concat(
      sent
        .filter((each) => each.command === "UploadPartCommand")
        .map((each) => each.input.Body as Buffer),
    );

    expect(joined.toString()).toBe("abcdefghijk");
  });

  it("writes an object smaller than a part in one PutObject, with the storage class", async () => {
    const { client, sent } = recordingClient();
    const storage = createS3ArchiveStorage({
      client,
      bucket: "trajetto-archive-test",
      storageClass: "STANDARD_IA",
      partSize: 100,
    });

    await storage.put("trail/20261001/small.csv.gz", chunks(30, 20));

    expect(sent.map((each) => each.command)).toEqual(["PutObjectCommand"]);
    expect(sent[0].input).toMatchObject({
      Key: "trail/20261001/small.csv.gz",
      StorageClass: "STANDARD_IA",
      ContentType: ARCHIVE_CONTENT_TYPE,
    });
    expect(bodyLength(sent[0].input)).toBe(50);
  });

  it("aborts the multipart upload when a part fails, and rejects", async () => {
    const { client, sent } = recordingClient({ failOnPart: 2 });
    const storage = createS3ArchiveStorage({
      client,
      bucket: "b",
      storageClass: "STANDARD",
      partSize: 10,
    });

    await expect(storage.put("k", chunks(10, 10, 10))).rejects.toThrow(
      "R2 indisponível",
    );

    const commands = sent.map((each) => each.command);

    expect(commands).toContain("AbortMultipartUploadCommand");
    expect(commands).not.toContain("CompleteMultipartUploadCommand");
    expect(sent[sent.length - 1]?.input).toMatchObject({
      Key: "k",
      UploadId: "u-1",
    });
  });

  it("aborts when the body itself fails after a part went up", async () => {
    const { client, sent } = recordingClient();
    const storage = createS3ArchiveStorage({
      client,
      bucket: "b",
      storageClass: "STANDARD",
      partSize: 10,
    });

    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(12);
      throw new Error("o banco caiu");
    }

    await expect(storage.put("k", failing())).rejects.toThrow("o banco caiu");
    expect(sent.map((each) => each.command)).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "AbortMultipartUploadCommand",
    ]);
  });

  it("deletes key by key", async () => {
    const { client, sent } = recordingClient();
    const storage = createS3ArchiveStorage({
      client,
      bucket: "b",
      storageClass: "STANDARD",
    });

    await storage.deleteMany(["a", "b"]);

    expect(sent).toEqual([
      { command: "DeleteObjectCommand", input: { Bucket: "b", Key: "a" } },
      { command: "DeleteObjectCommand", input: { Bucket: "b", Key: "b" } },
    ]);
  });
});

describe("missingArchiveSettings", () => {
  it("names what the archive storage lacks, and nothing when it has it all", () => {
    expect(missingArchiveSettings({})).toEqual([
      "TRAIL_ARCHIVE_BUCKET",
      "ARCHIVE_R2_ACCESS_KEY_ID",
      "ARCHIVE_R2_SECRET_ACCESS_KEY",
      "R2_ACCOUNT_ID",
    ]);

    expect(
      missingArchiveSettings({
        TRAIL_ARCHIVE_BUCKET: "trajetto-archive-staging",
        ARCHIVE_R2_ACCESS_KEY_ID: "id",
        ARCHIVE_R2_SECRET_ACCESS_KEY: "secret",
        R2_ACCOUNT_ID: "account",
      }),
    ).toEqual([]);

    // An S3-compatible endpoint stands for the account.
    expect(
      missingArchiveSettings({
        TRAIL_ARCHIVE_BUCKET: "b",
        ARCHIVE_R2_ACCESS_KEY_ID: "id",
        ARCHIVE_R2_SECRET_ACCESS_KEY: "secret",
        R2_ENDPOINT: "http://127.0.0.1:9000",
      }),
    ).toEqual([]);
  });
});
