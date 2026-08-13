import { inject, injectable } from "tsyringe";

import { UploadService } from "@/shared/services/upload-service";
import type { UploadType } from "@/config/upload";

interface PresignedUploadFile {
  originalFilename: string;
  contentType: string;
  size: number;
}

interface CreatePresignedUploadProps {
  uploadType: UploadType;
  files: PresignedUploadFile[];
  scopeId: string;

  // Only used by the local storage fallback in development.
  publicBaseUrl?: string;
}

interface PresignedUpload {
  key: string;
  uploadUrl: string;
  expiresIn: number;
}

@injectable()
class CreatePresignedUploadUseCase {
  constructor(
    @inject("UploadService")
    private upload: UploadService,
  ) {}

  /**
   * Hands the client one signed PUT per file so it can upload straight to R2.
   *
   * Signing is independent per file and the service validates each one, so a
   * single bad entry fails the whole batch before any URL is handed out —
   * better than letting the client upload nineteen photos and discover the
   * twentieth was rejected.
   */
  async execute({
    uploadType,
    files,
    scopeId,
    publicBaseUrl,
  }: CreatePresignedUploadProps): Promise<PresignedUpload[]> {
    return Promise.all(
      files.map((file) =>
        this.upload.createPresignedUpload(
          file,
          uploadType,
          scopeId,
          publicBaseUrl,
        ),
      ),
    );
  }
}

export { CreatePresignedUploadUseCase };
export type { CreatePresignedUploadProps, PresignedUpload };
