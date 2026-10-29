import { env } from "@/env";
import path from "node:path";

/**
 * The one list of upload namespaces. The size table, the presign schema's
 * enum and extractFilePath's prefix check all derive from it — a new type
 * added here can no longer be forgotten in one of them (deliveryPhotos was,
 * and every proof photo came back as "Caminho de arquivo inválido").
 */
export const UPLOAD_TYPES = [
  "odometerPhotos",
  "avatars",
  "checklistPhotos",
  "deliveryPhotos",
  "chatAttachments",

  // The one namespace the SERVER writes into. Everything above arrives from a
  // phone or a browser through a presigned PUT; a proof document only exists
  // here, so `putObject` is what writes it — and it still has to be a declared
  // namespace, because `extractFilePath` refusing an undeclared prefix is what
  // keeps a key from pointing anywhere in the bucket.
  "deliveryProofs",
] as const;

export type UploadType = (typeof UPLOAD_TYPES)[number];

const MIME_TYPES = {
  images: ["image/jpeg", "image/jpg", "image/png", "image/webp"],

  // AAC/M4A only, deliberately: it is what expo-audio records on both
  // platforms and the one compressed format every browser plays back.
  // Browser MediaRecorder output (WebM/Opus) is refused — iOS cannot play
  // it, so accepting it would create messages half the fleet cannot hear.
  audio: ["audio/m4a", "audio/x-m4a", "audio/mp4", "audio/aac"],
};

export const uploadConfig = {
  storage: {
    type: env.UPLOAD_STORAGE_TYPE as "local" | "r2",
    localPath: path.resolve(env.UPLOAD_LOCAL_PATH),
  },
  r2: {
    accountId: env.R2_ACCOUNT_ID || "",
    bucket: env.R2_BUCKET_NAME || "",
    accessKeyId: env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
    // Unset: the account's R2 endpoint. Set: any S3-compatible storage
    // (the upload E2E runs against a local MinIO), addressed path-style.
    endpoint:
      env.R2_ENDPOINT ||
      `https://${env.R2_ACCOUNT_ID || ""}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(env.R2_ENDPOINT),
  },
  signedUrlTtlSeconds: env.UPLOAD_SIGNED_URL_TTL_SECONDS,

  // Separate from the read TTL on purpose. A read URL may live for a while so
  // a page can render; an upload authorisation should expire almost as soon as
  // the client is done with it.
  presignedUploadTtlSeconds: 300,

  // Ceiling for a checklist as a whole, on top of the per-file limit below.
  // Twenty photos at the individual limit would otherwise be 100 MB for one
  // inspection. Checked in `resolvePresignedUploads`, which is the only place
  // that knows every real byte count.
  maxChecklistTotalBytes: 5 * 1024 * 1024,

  // Per-file limit. Signed into the presigned PUT as `ContentLength`, so
  // storage refuses an oversized upload itself, and re-checked against the
  // object that actually landed before its key becomes a database row.
  getSizeLimit: (uploadType: UploadType, contentType?: string) => {
    // A voice note is bounded by bytes, not by the duration it claims.
    //
    // `durationMs` arrives from the client and the server has no way to
    // audit it — a tampered app can declare sixty seconds over a ten-minute
    // recording. The two-minute rule is therefore a product rule, and this
    // is the enforceable half: the ceiling is signed into the presigned PUT
    // as ContentLength, so storage itself refuses the write, and the object
    // that landed is re-checked against the same number before its key
    // becomes a row. At the app's recording bitrate a two-minute note is
    // around 500 kB, so this leaves generous headroom while cutting what an
    // abusive client can actually park in the bucket.
    if (uploadType === "chatAttachments" && contentType?.startsWith("audio/")) {
      return 2 * 1024 * 1024; // 2MB
    }

    // Record<UploadType, number>: a type without a limit fails to compile.
    const limits: Record<UploadType, number> = {
      odometerPhotos: 5 * 1024 * 1024, // 5MB
      avatars: 5 * 1024 * 1024, // 5MB
      checklistPhotos: 5 * 1024 * 1024, // 5MB
      // Canhoto, occurrence shots and the on-screen signature: the app's
      // queue uploads one type per submission, so they share the namespace.
      deliveryPhotos: 5 * 1024 * 1024, // 5MB
      // Chat photos. Voice notes share this namespace but take the tighter
      // audio ceiling above — the same key prefix, two different bounds.
      chatAttachments: 5 * 1024 * 1024, // 5MB

      // A receipt carries a photo plus the signature, so it is the one
      // document here that is not a single image. Ten megabytes is far past
      // anything the renderer produces and still a ceiling.
      deliveryProofs: 10 * 1024 * 1024, // 10MB
    };

    return limits[uploadType];
  },
  allowedMimeTypes: MIME_TYPES,

  // Which MIME families each namespace accepts. Everything is image-only
  // except the chat, where the driver's voice notes live.
  getAllowedMimeTypes: (uploadType: UploadType): string[] => {
    if (uploadType === "chatAttachments") {
      return [...MIME_TYPES.images, ...MIME_TYPES.audio];
    }

    if (uploadType === "deliveryProofs") {
      return ["application/pdf"];
    }

    return MIME_TYPES.images;
  },

  /**
   * Namespaces no client may ever be handed a signature for.
   *
   * A proof document is written by the server and by nothing else. Letting a
   * browser presign a PUT into that prefix would let somebody drop their own
   * bytes onto a receipt's key — the verification page would catch it and say
   * the file no longer matches its hash, which is the right answer to the
   * wrong question. The answer to the right question is that the write must
   * not be possible.
   */
  serverOnlyUploadTypes: ["deliveryProofs"] as UploadType[],
};

export type UploadConfig = typeof uploadConfig;
