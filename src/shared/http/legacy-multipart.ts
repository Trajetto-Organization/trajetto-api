import type { FastifyInstance, FastifyRequest } from "fastify";

import { randomUUID } from "node:crypto";
import { container } from "tsyringe";

import { uploadConfig } from "@/config/upload";
import { AppError } from "@/shared/errors/AppError";
import { urlForLog } from "@/shared/logging/redact-url";

import type { UploadService } from "@/shared/services/upload-service";
import { submissionKeyOf } from "./submission-key";

/**
 * Multipart, for the one client that still needs it, on the two routes it
 * posts to. TEMPORARY: see "When this goes" at the bottom.
 *
 * Photo uploads moved to presigned PUTs: the bytes go from the phone straight
 * to the bucket and only their keys reach this API. The app build in drivers'
 * hands today predates that — it is the only binary the mobile repository's
 * `main` can produce — and posts a fueling and a checklist as multipart, with
 * the photos inside. A new binary has to pass store review and be installed
 * before it replaces that one, and the JS that speaks presign cannot reach it
 * over the air (the native fingerprint changed). Refusing multipart, as this
 * API did, failed every fueling and checklist those phones sent.
 *
 * So the two create routes parse it again, and only them: the parser is
 * registered in a scope that holds nothing else. What this does is turn the
 * old request into the new one, and stop there:
 *
 *   1. The parser splits the body into text fields — which become the body,
 *      so the tenant and branch guards read `businessId`/`branchId` exactly
 *      as they do from JSON — and file parts, held aside.
 *   2. A preHandler that runs LAST, after every guard, writes each photo to
 *      storage under the namespace the presigned flow uses
 *      (`<uploadType>/<businessId>/…`) and puts the keys into the body in the
 *      presigned shape (`photo: {key}` / `photos: [{key, fieldName}]`).
 *   3. The controller and use case run unchanged. Idempotency, the
 *      ownership check, the existence and size checks against storage, the
 *      checklist's aggregate limit: all of it is the presigned path's.
 *
 * No re-encoding (sharp is gone for good): that build already re-encodes to
 * JPEG on the phone before sending. The bytes are identified by their
 * signature, never by the part's declared type, and anything that is not a
 * JPEG, PNG or WebP is refused before anything is stored.
 *
 * Parsed from a bounded buffer rather than through a streaming plugin: the
 * body limit caps what is held in memory at what that build's own limit
 * allows (5 MB of photos), which is also what `@fastify/multipart` would have
 * buffered for these two routes, and it leaves no dependency behind when the
 * adapter is removed.
 */

type LegacyShape = "fuel" | "checklist";

interface LegacyFile {
  fieldName: string;
  bytes: Buffer;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: LegacyFile[];
}

interface MultipartLimits {
  maxFiles: number;
  maxFields?: number;
  maxFieldBytes?: number;
}

const MAX_FIELDS = 100;
const MAX_FIELD_BYTES = 64 * 1024;

// Headers, field values and multipart framing on top of the photos. The
// checklist has some forty text fields; none of them is long.
const FIELDS_ALLOWANCE_BYTES = 256 * 1024;

// Names that would reach an object's prototype if assigned naively. The body
// is built with `Object.fromEntries`, which cannot pollute, but a field with
// one of these names is never a real form field either.
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function malformed(): AppError {
  return new AppError(
    "Não foi possível ler o envio. Tente novamente.",
    400,
    "MALFORMED_MULTIPART",
  );
}

function boundaryOf(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];

  // RFC 2046 caps a boundary at 70 characters.
  return boundary && boundary.length <= 70 ? boundary : null;
}

function dispositionParam(disposition: string, param: string): string | null {
  const match = new RegExp(`;\\s*${param}=(?:"([^"]*)"|([^;\\s]+))`, "i").exec(
    disposition,
  );

  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Splits a `multipart/form-data` body into text fields and file parts.
 *
 * A part is a file when its disposition carries a `filename`, which is how
 * both React Native platforms mark an appended `{ uri, name, type }`. The
 * name alone cannot tell them apart: the checklist sends each photo under the
 * name of the question it documents, so `current_mileage` arrives both as a
 * field and as a photo.
 */
function parseMultipartFormData(
  body: Buffer,
  contentType: string,
  limits: MultipartLimits,
): ParsedMultipart {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw malformed();

  const maxFields = limits.maxFields ?? MAX_FIELDS;
  const maxFieldBytes = limits.maxFieldBytes ?? MAX_FIELD_BYTES;

  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = Buffer.from("\r\n\r\n");

  const fields = new Map<string, string>();
  const files: LegacyFile[] = [];

  let position = body.indexOf(delimiter);
  if (position === -1) throw malformed();

  for (;;) {
    let cursor = position + delimiter.length;

    // `--boundary--` closes the body; whatever follows is epilogue.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;

    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) throw malformed();
    cursor += 2;

    const headersEnd = body.indexOf(headerEnd, cursor);
    if (headersEnd === -1) throw malformed();

    const contentStart = headersEnd + headerEnd.length;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd === -1) throw malformed();

    const headers = body
      .subarray(cursor, headersEnd)
      .toString("utf8")
      .split("\r\n");
    const disposition =
      headers.find((line) => /^content-disposition:/i.test(line)) ?? "";

    const name = dispositionParam(disposition, "name");
    if (!name) throw malformed();

    const content = body.subarray(contentStart, contentEnd);

    if (dispositionParam(disposition, "filename") !== null) {
      if (files.length >= limits.maxFiles) {
        throw new AppError(
          `No máximo ${limits.maxFiles} foto(s) por envio.`,
          400,
          "UPLOAD_FILE_LIMIT_EXCEEDED",
        );
      }

      files.push({ fieldName: name, bytes: Buffer.from(content) });
    } else {
      if (fields.size >= maxFields || content.length > maxFieldBytes) {
        throw malformed();
      }

      if (!RESERVED_NAMES.has(name)) fields.set(name, content.toString("utf8"));
    }

    position = contentEnd + 2;
  }

  return { fields: Object.fromEntries(fields), files };
}

/** What the bytes are, from their signature. Null for anything else. */
function sniffImage(
  bytes: Buffer,
): { contentType: string; extension: string } | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }

  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: "image/png", extension: "png" };
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }

  return null;
}

// Per request, from the parser to the preHandler, and from the preHandler to
// the response hook. Keyed by the request object so nothing leaks between
// requests and nothing outlives one.
const heldFiles = new WeakMap<FastifyRequest, LegacyFile[]>();
const storedKeys = new WeakMap<FastifyRequest, string[]>();

interface LegacyMultipartOptions {
  shape: LegacyShape;

  /**
   * The record an earlier attempt already created under this key. A resend
   * of it is answered by the controller before the photo is looked at, so
   * its bytes are not stored a second time.
   */
  findReplay: (
    businessId: string,
    submissionId: string,
    callerDriverId: string | null | undefined,
  ) => Promise<unknown | null>;
}

const SHAPES: Record<
  LegacyShape,
  {
    uploadType: "odometerPhotos" | "checklistPhotos";
    maxFiles: number;
    maxPhotoBytes: number;
  }
> = {
  // One odometer photo; the old controller read the first file part only.
  fuel: {
    uploadType: "odometerPhotos",
    maxFiles: 1,
    maxPhotoBytes: uploadConfig.getSizeLimit("odometerPhotos"),
  },

  // The old controller's own ceilings: 20 photos, 5 MB for all of them.
  checklist: {
    uploadType: "checklistPhotos",
    maxFiles: 20,
    maxPhotoBytes: uploadConfig.maxChecklistTotalBytes,
  },
};

function recordDeprecatedContract(
  request: FastifyRequest,
  shape: LegacyShape,
): void {
  // The same message the refusal on every other route logs, so one search
  // over the logs answers "is that build still out there?".
  request.log.warn(
    {
      // The route pattern, never the raw URL (OBS-05), like every other line.
      url: urlForLog(request),
      shape,
      accepted: true,
      userAgent: request.headers["user-agent"],
    },
    "Deprecated contract: multipart upload from an outdated client",
  );
}

/**
 * Makes the scope parse multipart, turns it into the presigned request, and
 * cleans up after a refusal. Register ONE route in the scope: every route in
 * it would accept multipart.
 */
function acceptLegacyMultipart(
  scope: FastifyInstance,
  options: LegacyMultipartOptions,
) {
  const shape = SHAPES[options.shape];

  scope.addContentTypeParser(
    "multipart/form-data",
    {
      parseAs: "buffer",
      bodyLimit: shape.maxPhotoBytes + FIELDS_ALLOWANCE_BYTES,
    },
    (request, body, done) => {
      try {
        const parsed = parseMultipartFormData(
          body as Buffer,
          String(request.headers["content-type"] ?? ""),
          { maxFiles: shape.maxFiles },
        );

        heldFiles.set(request, parsed.files);
        done(null, parsed.fields);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * A refused request leaves nothing behind in storage.
   *
   * Only for these server-written keys, and that is what makes it safe: they
   * are minted per attempt and never handed to the client, so no retry can
   * come back for one (the presigned keys, which a retry DOES reuse, are
   * never deleted this way). A 4xx means no record points at them. A 5xx
   * keeps them — whether the record was written is exactly what is unknown,
   * and an orphan costs less than a record without its evidence.
   */
  scope.addHook("onResponse", async (request, reply) => {
    const keys = storedKeys.get(request);
    if (!keys || reply.statusCode < 400 || reply.statusCode >= 500) return;

    const uploads = container.resolve<UploadService>("UploadService");

    await Promise.allSettled(keys.map((key) => uploads.deleteFile(key)));
  });

  /**
   * The preHandler that stores the photos. Goes LAST in the route's list:
   * nothing reaches storage for a caller the guards refuse.
   */
  return async function materializeLegacyUploads(request: FastifyRequest) {
    const files = heldFiles.get(request);
    if (!files) return; // A JSON request: the presigned path, untouched.

    heldFiles.delete(request);
    recordDeprecatedContract(request, options.shape);

    const { businessId } = request.params as { businessId: string };
    const fields = (request.body ?? {}) as Record<string, unknown>;

    const replayKey = submissionKeyOf(
      fields,
      request.headers["idempotency-key"],
    );

    if (
      replayKey &&
      (await options.findReplay(businessId, replayKey, request.user?.driverId))
    ) {
      return;
    }

    // The old fueling controller took the first file part, whatever its name.
    const photos = options.shape === "fuel" ? files.slice(0, 1) : files;

    // Every photo is checked before any is stored, so a bad part in the
    // middle of twenty leaves nothing half-written behind.
    const checked = photos.map((photo) => {
      const image = sniffImage(photo.bytes);

      if (!image) {
        throw new AppError(
          "Formato de foto não suportado. Envie uma imagem JPEG, PNG ou WebP.",
          400,
          "UNSUPPORTED_FILE_TYPE",
        );
      }

      return { ...photo, ...image };
    });

    const totalBytes = checked.reduce(
      (total, photo) => total + photo.bytes.length,
      0,
    );

    if (totalBytes > shape.maxPhotoBytes) {
      throw new AppError(
        `O tamanho total das fotos excede o limite permitido de ${Math.round(
          shape.maxPhotoBytes / 1024 / 1024,
        )} MB.`,
        400,
        "UPLOAD_SIZE_LIMIT_EXCEEDED",
      );
    }

    const uploads = container.resolve<UploadService>("UploadService");
    const stored: { key: string; fieldName: string }[] = [];

    storedKeys.set(request, []);

    for (const photo of checked) {
      const key = `${shape.uploadType}/${businessId}/${Date.now()}-legacy-${randomUUID().slice(0, 8)}.${photo.extension}`;

      await uploads.putObject(key, photo.bytes, photo.contentType);

      storedKeys.get(request)?.push(key);
      stored.push({ key, fieldName: photo.fieldName });
    }

    request.body =
      options.shape === "fuel"
        ? { ...fields, ...(stored[0] && { photo: { key: stored[0].key } }) }
        : { ...fields, photos: stored };
  };
}

/*
  When this goes

  Delete this file, its two `acceptLegacyMultipart` scopes (fuel-routes.ts,
  vehicle-checklist-routes.ts) and the tests that post multipart to them once
  the log line "Deprecated contract: multipart upload from an outdated client"
  with `accepted: true` has been absent from every replica for 14 days AFTER
  the presigned build is installed on the drivers' phones. The refusal on
  every other route (the CLIENT_OUTDATED branch in http.ts) stays.
*/

export { acceptLegacyMultipart, parseMultipartFormData, sniffImage };
export type { LegacyMultipartOptions, ParsedMultipart };
