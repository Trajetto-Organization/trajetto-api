import { env } from "@/env";
import path from "node:path";

export const uploadConfig = {
  storage: {
    type: env.UPLOAD_STORAGE_TYPE as "local" | "s3",
    localPath: path.resolve(env.UPLOAD_LOCAL_PATH),
  },
  aws: {
    region: env.AWS_REGION || "us-east-1",
    bucket: env.AWS_S3_BUCKET || "",
    accessKeyId: env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || "",
  },
  // Size limits function
  getSizeLimit: (
    uploadType: "odometerPhotos" | "avatars" | "checklistPhotos",
  ) => {
    const limits = {
      odometerPhotos: 5 * 1024 * 1024, // 5MB
      avatars: 10 * 1024 * 1024, // 10MB
      checklistPhotos: 3 * 1024 * 1024, // 3MB
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
