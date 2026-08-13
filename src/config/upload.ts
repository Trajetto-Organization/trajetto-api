import { env } from "@/env";
import path from "node:path";

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
  },
  signedUrlTtlSeconds: env.UPLOAD_SIGNED_URL_TTL_SECONDS,

  // Separate from the read TTL on purpose. A read URL may live for a while so
  // a page can render; an upload authorisation should expire almost as soon as
  // the client is done with it.
  presignedUploadTtlSeconds: 300,

  // Ceiling for a checklist as a whole, on top of the per-file limit below.
  // Twenty photos at the individual limit would otherwise be 100 MB for one
  // inspection.
  maxChecklistTotalBytes: 5 * 1024 * 1024,
  // Size limits function
  getSizeLimit: (
    uploadType: "odometerPhotos" | "avatars" | "checklistPhotos",
  ) => {
    const limits = {
      odometerPhotos: 5 * 1024 * 1024, // 5MB
      avatars: 5 * 1024 * 1024, // 5MB
      checklistPhotos: 5 * 1024 * 1024, // 5MB
    };

    return limits[uploadType];
  },
  allowedMimeTypes: {
    images: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  },
  quality: {
    jpeg: 85,
    webp: 85,
  },
  resize: {
    odometerPhotos: {
      width: 1200,
      height: 1200,
      fit: "inside" as const,
      withoutEnlargement: true,
    },
    avatars: {
      width: 400,
      height: 400,
      fit: "cover" as const,
      withoutEnlargement: false,
    },
    checklistPhotos: {
      width: 800,
      height: 800,
      fit: "inside" as const,
      withoutEnlargement: true,
    },
  },
};

export type UploadConfig = typeof uploadConfig;
export type UploadType = "odometerPhotos" | "avatars" | "checklistPhotos";
