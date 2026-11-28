import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";

import { R2_CLIENT_TIMEOUTS } from "@/shared/services/upload-service";

import {
  missingArchiveSettings,
  type ArchiveStorageClass,
  type ArchiveStorageEnv,
} from "./archive-settings";

/**
 * Where the archives go (plano-escala F2-11): a bucket of its own, never the
 * uploads bucket. The archive bucket carries an Expiration rule (the trail's
 * objects go after TRAIL_ARCHIVE_RETENTION_DAYS); on the uploads bucket the
 * same rule would delete proofs of delivery. Its own token, too, scoped to
 * that bucket: the uploads token cannot read or delete an archive, and the
 * archive token cannot touch a photo.
 *
 * Two operations, both whole-object: write one object from a stream of
 * bytes, and delete objects by key. Nothing reads an archive back from the
 * API; a legal request downloads the object by hand (docs/arquitetura.md).
 */
interface ArchiveStorage {
  /**
   * Writes `body` as the object `key`, replacing any object there: the
   * object appears whole when this resolves, or not at all (a failed
   * multipart upload is aborted). A second write of the same key after a
   * crash replaces the first, so a key never holds two copies.
   */
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<void>;

  /** Deletes each key; an absent key counts as deleted. */
  deleteMany(keys: readonly string[]): Promise<void>;

  /**
   * The object's bytes, or null when the key holds nothing: a restore for
   * a legal request (infra/scripts/archive-restore.ts, plano-escala F5-16).
   * Nothing in the API reads the archive.
   */
  get(key: string): Promise<Buffer | null>;
}

/**
 * The size of every part of a multipart upload but the last. R2 asks for
 * parts of at least 5 MiB and, unlike S3, of the SAME size except the last:
 * the body is cut at exactly this many bytes, whatever size the gzip chunks
 * come in. An object smaller than one part goes up in one PutObject.
 */
const ARCHIVE_PART_SIZE = 8 * 1024 * 1024;

/** Each object is the gzip of a CSV: its bytes are what the sha256 covers. */
const ARCHIVE_CONTENT_TYPE = "application/gzip";

interface S3ArchiveStorageOptions {
  client: Pick<S3Client, "send">;
  bucket: string;
  storageClass: ArchiveStorageClass;
  partSize?: number;
}

/**
 * Takes exactly `size` bytes off the front of `pending`, or null when there
 * are fewer: the parts of a multipart upload must all be the same size.
 */
function takePart(pending: Buffer[], size: number): Buffer | null {
  const available = pending.reduce((total, chunk) => total + chunk.length, 0);

  if (available < size) return null;

  const joined = Buffer.concat(pending);

  pending.length = 0;

  if (joined.length > size) pending.push(joined.subarray(size));

  return joined.subarray(0, size);
}

function createS3ArchiveStorage(
  options: S3ArchiveStorageOptions,
): ArchiveStorage {
  const { client, bucket, storageClass } = options;
  const partSize = options.partSize ?? ARCHIVE_PART_SIZE;

  return {
    async put(key, body) {
      const pending: Buffer[] = [];
      const parts: CompletedPart[] = [];
      let uploadId: string | undefined;

      const uploadPart = async (part: Buffer) => {
        const partNumber = parts.length + 1;
        const { ETag } = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: part,
          }),
        );

        parts.push({ ETag, PartNumber: partNumber });
      };

      try {
        for await (const chunk of body) {
          pending.push(Buffer.from(chunk));

          for (
            let part = takePart(pending, partSize);
            part !== null;
            part = takePart(pending, partSize)
          ) {
            if (uploadId === undefined) {
              const created = await client.send(
                new CreateMultipartUploadCommand({
                  Bucket: bucket,
                  Key: key,
                  ContentType: ARCHIVE_CONTENT_TYPE,
                  StorageClass: storageClass,
                }),
              );

              if (!created.UploadId) {
                throw new Error(`o R2 não devolveu o UploadId de ${key}`);
              }

              uploadId = created.UploadId;
            }

            await uploadPart(part);
          }
        }

        const rest = Buffer.concat(pending);

        if (uploadId === undefined) {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: rest,
              ContentType: ARCHIVE_CONTENT_TYPE,
              StorageClass: storageClass,
            }),
          );

          return;
        }

        if (rest.length > 0) await uploadPart(rest);

        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
      } catch (error) {
        // The parts already sent are billed storage until aborted; the
        // bucket's abort rule would also get them, a week later.
        if (uploadId !== undefined) {
          await client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
              }),
            )
            .catch(() => undefined);
        }

        throw error;
      }
    },

    async get(key) {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );

        if (!Body) return null;

        return Buffer.from(
          await (
            Body as { transformToByteArray: () => Promise<Uint8Array> }
          ).transformToByteArray(),
        );
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;

        throw error;
      }
    },

    async deleteMany(keys) {
      // One DeleteObject per key, the call the uploads already make against
      // R2 in production: a company has at most a few hundred archives,
      // and a batch delete would bring a checksum header R2 was never
      // exercised with here.
      for (const key of keys) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      }
    },
  };
}

/**
 * The archive storage this environment configures, or null when a setting
 * is missing (missingArchiveSettings says which). The same account and
 * endpoint as the uploads (R2_ACCOUNT_ID, or R2_ENDPOINT for an
 * S3-compatible server), with the archive's own bucket and token, and the
 * uploads' timeouts: every call is bounded.
 */
function archiveStorageFromEnv(
  values: ArchiveStorageEnv,
): ArchiveStorage | null {
  if (missingArchiveSettings(values).length > 0) return null;

  const client = new S3Client({
    credentials: {
      accessKeyId: values.ARCHIVE_R2_ACCESS_KEY_ID as string,
      secretAccessKey: values.ARCHIVE_R2_SECRET_ACCESS_KEY as string,
    },
    endpoint:
      values.R2_ENDPOINT ||
      `https://${values.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(values.R2_ENDPOINT),
    region: "auto",
    maxAttempts: R2_CLIENT_TIMEOUTS.maxAttempts,
    // A checksum only where the operation demands one: the multipart calls
    // then carry none, so the parts and their completion always agree.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: R2_CLIENT_TIMEOUTS.connectionTimeoutMs,
      requestTimeout: R2_CLIENT_TIMEOUTS.requestTimeoutMs,
      throwOnRequestTimeout: true,
      socketTimeout: R2_CLIENT_TIMEOUTS.socketTimeoutMs,
    },
  });

  return createS3ArchiveStorage({
    client,
    bucket: values.TRAIL_ARCHIVE_BUCKET as string,
    storageClass: values.ARCHIVE_STORAGE_CLASS,
  });
}

export {
  ARCHIVE_CONTENT_TYPE,
  ARCHIVE_PART_SIZE,
  archiveStorageFromEnv,
  createS3ArchiveStorage,
};
export type { ArchiveStorage };
