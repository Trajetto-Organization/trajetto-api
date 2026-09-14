import { injectable } from "tsyringe";

// AWS SDK v3 (modular). O v2 (`aws-sdk`) empacotava o cliente de TODOS os
// servicos da AWS para usarmos dois metodos de S3, e esta em maintenance mode
// desde 2024 — so recebe correcao critica.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import fs from "node:fs";
import path from "node:path";

import { uploadConfig, UploadType, UPLOAD_TYPES } from "@/config/upload";
import { v4 as uuid } from "uuid";

import { getRequestContext } from "@/shared/http/request-context";
import { env } from "@/env";

import { AppError } from "@/shared/errors/AppError";
import { signLocalUploadToken } from "@/shared/services/local-upload-token";

/**
 * The file extension each accepted content type lands under.
 *
 * A table rather than a ladder, and every allowed type is in it. The ladder
 * this replaced ended in `: "jpg"`, so every voice note was stored as a .jpg —
 * the signed url played anyway, but the key lied to storage, to any CDN
 * sniffing by extension, and to the mobile cache, which takes a note's file
 * extension from that path. Nothing here re-encodes bytes: the extension has
 * to follow the content type that was signed, which is what the comment on
 * `generatePresignedKey` always claimed.
 *
 * `bin` for anything unlisted, which the mime allow-list should have refused
 * long before here — an unknown type is not a jpeg.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

@injectable()
class UploadService {
  private s3?: S3Client;

  constructor() {
    if (uploadConfig.storage.type === "r2") {
      this.s3 = new S3Client({
        credentials: {
          accessKeyId: uploadConfig.r2.accessKeyId,
          secretAccessKey: uploadConfig.r2.secretAccessKey,
        },
        endpoint: `https://${uploadConfig.r2.accountId}.r2.cloudflarestorage.com`,
        region: "auto",
      });
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      const normalizedFilePath = this.extractFilePath(filePath);
      if (uploadConfig.storage.type === "r2") {
        if (!this.s3) {
          throw new AppError("R2 não foi configurado corretamente", 500);
        }

        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: uploadConfig.r2.bucket,
            Key: normalizedFilePath,
          }),
        );
      } else {
        const fullPath = path.join(
          uploadConfig.storage.localPath,
          normalizedFilePath,
        );

        try {
          await fs.promises.access(fullPath);
          await fs.promises.unlink(fullPath);
        } catch {
          // File doesn't exist, ignore
        }
      }
    } catch (error) {
      console.error("Erro ao deletar arquivo:", error);
      // Don't throw error for file deletion failures
    }
  }

  extractFilePath(filePathOrUrl: string): string {
    try {
      const candidate = /^https?:\/\//i.test(filePathOrUrl)
        ? decodeURIComponent(new URL(filePathOrUrl).pathname)
        : decodeURIComponent(filePathOrUrl.split("?")[0]);
      // Derived from the config's one list — a hand-written copy here is
      // exactly how deliveryPhotos got refused with INVALID_FILE_PATH.
      const uploadPrefix = UPLOAD_TYPES.map((type) => `${type}/`).find(
        (prefix) => candidate.includes(prefix),
      );

      if (!uploadPrefix) {
        throw new Error("Unknown upload path");
      }

      const normalized = candidate.substring(candidate.indexOf(uploadPrefix));
      if (
        normalized.includes("..") ||
        normalized.includes("\\") ||
        path.isAbsolute(normalized)
      ) {
        throw new Error("Unsafe upload path");
      }

      return normalized;
    } catch {
      throw new AppError(
        "Caminho de arquivo inválido.",
        400,
        "INVALID_FILE_PATH",
      );
    }
  }

  /**
   * Signs a direct-to-R2 upload.
   *
   * The point of this endpoint is that the bytes never pass through the API:
   * the client PUTs straight to the bucket. That removes two hops (browser →
   * Next, buffered whole in memory → Fastify → R2) which do not scale once
   * both the web app and the mobile app are sending checklists of up to twenty
   * photos each.
   *
   * What keeps it safe:
   *
   *   - The key is generated HERE and namespaced by `scopeId`, the owner of
   *     the file. For business data that is the businessId; for avatars it is
   *     the userId, since an avatar belongs to a person and a MASTER user may
   *     have no business at all. A client cannot choose where it writes, so it
   *     cannot write into another owner prefix.
   *   - `ContentType` and `ContentLength` go into the signature, which makes
   *     them signed headers. R2 rejects a PUT whose type or byte count does
   *     not match exactly — so the size limit is enforced by the bucket, not
   *     by trust.
   *   - The URL is short lived, on its own TTL rather than the read one.
   *
   * The caller must still confirm with `headUploadedObject` before persisting
   * the key: a signature authorises an upload, it does not prove one happened.
   */
  async createPresignedUpload(
    file: { originalFilename: string; contentType: string; size: number },
    uploadType: UploadType,
    scopeId: string,

    // Where the client reached this API, used only to build the local upload
    // URL in development. Without it the URL is whatever `API_HTTP_REQUEST`
    // says, which is `localhost` — correct in a browser on the dev machine and
    // useless on a phone, where localhost is the phone.
    publicBaseUrl?: string,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    if (
      !uploadConfig.getAllowedMimeTypes(uploadType).includes(file.contentType)
    ) {
      throw new AppError(
        "Tipo de arquivo não suportado para este envio.",
        400,
        "UNSUPPORTED_FILE_TYPE",
      );
    }

    const maxSize = uploadConfig.getSizeLimit(uploadType, file.contentType);

    if (file.size <= 0 || file.size > maxSize) {
      throw new AppError(
        `Arquivo excede o limite de ${Math.round(maxSize / 1024 / 1024)}MB.`,
        400,
        "FILE_TOO_LARGE",
      );
    }

    const key = this.generatePresignedKey(
      file.originalFilename,
      uploadType,
      scopeId,
      file.contentType,
    );

    // Local storage: same flow, different destination. The client still gets a
    // URL and still PUTs to it, so what runs on localhost is the code path that
    // runs in production — the alternative was development having no upload at
    // all, which is how a bug like this one hides.
    if (uploadConfig.storage.type !== "r2" || !this.s3) {
      const expiresAt =
        Date.now() + uploadConfig.presignedUploadTtlSeconds * 1000;

      const token = signLocalUploadToken({
        key,
        contentType: file.contentType,
        size: file.size,
        expiresAt,
      });

      // The caller's own host wins. It is client-controlled, but it only
      // shapes a URL handed back to that same client — the token that
      // authorises the write is signed independently of it.
      const baseUrl =
        publicBaseUrl || env.API_HTTP_REQUEST || `http://localhost:${env.PORT}`;

      return {
        key,

        // The token rides in the query string, not the path — the same place
        // S3 puts `X-Amz-Signature`, and the only one that works: Fastify caps
        // a path parameter at 100 characters and answers 404 past that, which
        // this token comfortably exceeds.
        uploadUrl: `${baseUrl}/uploads/local?token=${encodeURIComponent(token)}`,
        expiresIn: uploadConfig.presignedUploadTtlSeconds,
      };
    }

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: uploadConfig.r2.bucket,
        Key: key,
        ContentType: file.contentType,
        ContentLength: file.size,
      }),
      { expiresIn: uploadConfig.presignedUploadTtlSeconds },
    );

    return {
      key,
      uploadUrl,
      expiresIn: uploadConfig.presignedUploadTtlSeconds,
    };
  }

  /**
   * Turns keys handed back by the client into storage paths safe to persist.
   *
   * Two checks, and both are load-bearing:
   *
   *   1. The key must sit under this business prefix. The client is returning
   *      a string it was given earlier, and nothing stops it returning a
   *      different one — without this, a key learned from another tenant would
   *      be recorded against this checklist.
   *   2. The object must exist and match the limits for its type. A signature
   *      authorises an upload; it does not prove one happened, and a client is
   *      free to skip the PUT and post the key anyway.
   *
   * Together these are the whole guarantee: the bytes never reach the API, so
   * this is the only place where what landed in storage is checked at all.
   */
  async resolvePresignedUploads(
    photos: { key: string; fieldName?: string }[],
    uploadType: UploadType,
    scopeId: string,

    // Ceiling for the batch as a whole, on top of the per-file limit that
    // storage itself enforces. The only place that knows every real byte count
    // is this loop, after storage has been asked how big each object actually
    // is. Left undefined for uploads that only ever carry one file.
    maxTotalBytes?: number,
  ): Promise<{ path: string; fieldName?: string }[]> {
    const expectedPrefix = `${uploadType}/${scopeId}/`;

    const resolved = await Promise.all(
      photos.map(async (photo) => {
        // A key is an opaque string to R2, so `..` never traverses anything
        // there. It is rejected because the prefix check below is the only
        // thing standing between tenants, and it should not depend on nobody
        // ever normalizing this string somewhere downstream.
        const traverses =
          photo.key.includes("..") ||
          photo.key.includes("\\") ||
          photo.key.includes("//");

        if (traverses || !photo.key.startsWith(expectedPrefix)) {
          throw new AppError(
            "Arquivo enviado não pertence a esta empresa.",
            403,
            "UPLOAD_KEY_FORBIDDEN",
          );
        }

        const { size } = await this.headUploadedObject(photo.key, uploadType);
        return { path: photo.key, fieldName: photo.fieldName, size };
      }),
    );

    if (maxTotalBytes !== undefined) {
      const totalBytes = resolved.reduce((total, { size }) => total + size, 0);

      if (totalBytes > maxTotalBytes) {
        throw new AppError(
          `O tamanho total das fotos excede o limite permitido de ${Math.round(
            maxTotalBytes / 1024 / 1024,
          )} MB.`,
          400,
          "UPLOAD_SIZE_LIMIT_EXCEEDED",
        );
      }
    }

    return resolved.map(({ path, fieldName }) => ({ path, fieldName }));
  }

  /**
   * Reads back what actually landed in the bucket.
   *
   * With a direct upload the API never sees the bytes, so this is where the
   * object is held to the rules at all: it must exist, be within the limit for
   * its type, and carry an image content type. Called before a key is written
   * to the database.
   */
  async headUploadedObject(
    key: string,
    uploadType: UploadType,
  ): Promise<{ size: number; contentType: string }> {
    // Local storage: the same question, asked of the filesystem. The checks
    // below are shared, so a file that would be rejected in production is
    // rejected in development too.
    if (uploadConfig.storage.type !== "r2" || !this.s3) {
      const fullPath = path.join(uploadConfig.storage.localPath, key);

      let stats;

      try {
        stats = await fs.promises.stat(fullPath);
      } catch {
        throw new AppError(
          "Arquivo enviado não foi encontrado no armazenamento.",
          400,
          "UPLOADED_FILE_NOT_FOUND",
        );
      }

      this.assertUploadedObjectWithinLimits(
        stats.size,
        this.contentTypeFromKey(key),
        uploadType,
      );

      return {
        size: stats.size,
        contentType: this.contentTypeFromKey(key),
      };
    }

    let head;

    try {
      head = await this.s3.send(
        new HeadObjectCommand({
          Bucket: uploadConfig.r2.bucket,
          Key: key,
        }),
      );
    } catch {
      throw new AppError(
        "Arquivo enviado não foi encontrado no armazenamento.",
        400,
        "UPLOADED_FILE_NOT_FOUND",
      );
    }

    const size = head.ContentLength ?? 0;
    const contentType = head.ContentType ?? "";

    this.assertUploadedObjectWithinLimits(size, contentType, uploadType);

    return { size, contentType };
  }

  private assertUploadedObjectWithinLimits(
    size: number,
    contentType: string,
    uploadType: UploadType,
  ): void {
    if (!uploadConfig.getAllowedMimeTypes(uploadType).includes(contentType)) {
      throw new AppError(
        "Tipo de arquivo não suportado.",
        400,
        "UNSUPPORTED_FILE_TYPE",
      );
    }

    if (size <= 0 || size > uploadConfig.getSizeLimit(uploadType, contentType)) {
      throw new AppError(
        "Arquivo enviado excede o limite permitido.",
        400,
        "FILE_TOO_LARGE",
      );
    }
  }

  /**
   * Local files carry no metadata, so the type comes from the extension the
   * key was generated with — which the API chose from the signed content type,
   * not from anything the client named.
   */
  private contentTypeFromKey(key: string): string {
    const extension = key.split(".").pop()?.toLowerCase();

    if (extension === "png") return "image/png";
    if (extension === "webp") return "image/webp";

    return "image/jpeg";
  }

  /**
   * Where an upload is allowed to land: the type, then the owner, then a name
   * that cannot collide. The extension follows the signed content type, since
   * the client uploads the bytes as they are and nothing re-encodes them on
   * the way in.
   */
  private generatePresignedKey(
    originalFilename: string,
    uploadType: UploadType,
    scopeId: string,
    contentType: string,
  ): string {
    const timestamp = Date.now();
    const randomId = uuid().substring(0, 8);

    const cleanName = originalFilename
      .replace(/.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .substring(0, 35);

    const extension = EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";

    return `${uploadType}/${scopeId}/${timestamp}-${cleanName || "file"}-${randomId}.${extension}`;
  }

  async getFileUrl(filePath: string): Promise<string> {
    const normalizedFilePath = this.extractFilePath(filePath);

    if (uploadConfig.storage.type === "r2") {
      if (!this.s3) {
        throw new AppError("R2 não foi configurado corretamente", 500);
      }

      // The bucket remains private. Consumers only receive a short-lived URL.
      // No v3 a assinatura e assincrona — dai `getFileUrl` retornar Promise.
      return getSignedUrl(
        this.s3,
        new GetObjectCommand({
          Bucket: uploadConfig.r2.bucket,
          Key: normalizedFilePath,
        }),
        { expiresIn: uploadConfig.signedUrlTtlSeconds },
      );
    } else {
      // Same rule as the upload side: the caller's own host wins.
      //
      // `API_HTTP_REQUEST` is a single value, and there is no single right
      // answer — the browser on the dev machine reaches this API at
      // `localhost`, the phone reaches it at the LAN address, and each needs
      // the URL on the host it can actually resolve. Answering `localhost` to
      // a phone points it at itself, which is why every chat photo, avatar
      // and voice note loaded forever and then failed there.
      //
      // The context is only populated outside production (see the onRequest
      // hook in http.ts); in production this branch does not run at all,
      // because R2 signs its own URLs above.
      const baseUrl =
        getRequestContext()?.publicBaseUrl ||
        env.API_HTTP_REQUEST ||
        `http://localhost:${env.PORT}`;

      return `${baseUrl}/tmp/${normalizedFilePath}`;
    }
  }
}

export { UploadService };
