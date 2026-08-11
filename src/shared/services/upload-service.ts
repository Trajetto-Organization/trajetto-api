import { injectable } from "tsyringe";

import sharp from "sharp";

// AWS SDK v3 (modular). O v2 (`aws-sdk`) empacotava o cliente de TODOS os
// servicos da AWS para usarmos dois metodos de S3, e esta em maintenance mode
// desde 2024 — so recebe correcao critica.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import fs from "node:fs";
import path from "node:path";

import { Readable } from "node:stream";
import pump from "pump";

import { uploadConfig, UploadType } from "@/config/upload";
import { v4 as uuid } from "uuid";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";

export interface UploadResult {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  url?: string;
}

export interface UploadFileOptions {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  uploadType: UploadType;
}

export interface UploadStreamOptions {
  stream: NodeJS.ReadableStream;
  filename: string;
  mimetype: string;
  uploadType: UploadType;
  fileSize?: number;
}

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

  private validateFile(
    buffer: Buffer,
    mimetype: string,
    uploadType: UploadType,
  ): void {
    // Validate MIME type
    if (!uploadConfig.allowedMimeTypes.images.includes(mimetype)) {
      throw new AppError(
        "Tipo de arquivo não suportado. Use apenas JPEG, PNG ou WebP.",
        400,
      );
    }

    // Validate file size using function
    const maxSize = uploadConfig.getSizeLimit(uploadType);
    if (buffer.length > maxSize) {
      const maxSizeMB = maxSize / (1024 * 1024);
      throw new AppError(
        `Arquivo muito grande. Tamanho máximo permitido: ${maxSizeMB}MB`,
        400,
      );
    }
  }

  private async processImage(
    buffer: Buffer,
    uploadType: UploadType,
  ): Promise<Buffer> {
    const config = uploadConfig.resize[uploadType];

    // `rotate()` applies EXIF orientation before resize. Sharp strips metadata
    // by default, which prevents GPS/device EXIF from leaking to clients.
    let sharpInstance = sharp(buffer, {
      limitInputPixels: 40_000_000,
      failOn: "warning",
    })
      .rotate()
      .resize(config.width, config.height, {
        fit: config.fit,
        withoutEnlargement: config.withoutEnlargement,
      });

    // Convert to WebP for better compression while maintaining quality
    sharpInstance = sharpInstance.webp({
      quality: uploadConfig.quality.webp,
    });

    return await sharpInstance.toBuffer();
  }

  private generateFilename(
    originalFilename: string,
    uploadType: UploadType,
  ): string {
    const timestamp = Date.now();
    const randomId = uuid().substring(0, 8);

    // Clean original filename: remove extension, sanitize, and limit length
    const cleanName = originalFilename
      .replace(/\.[^/.]+$/, "") // Remove extension
      .replace(/[^a-zA-Z0-9-_]/g, "-") // Replace special chars with dash
      .replace(/-+/g, "-") // Replace multiple dashes with single dash
      .replace(/^-|-$/g, "") // Remove leading/trailing dashes
      .toLowerCase()
      .substring(0, 35); // Limit to 35 characters (increased to accommodate vehicle checklist field names)

    // Always save as .webp for processed images
    const processedExtension = ".webp";
    return `${uploadType}/${timestamp}-${cleanName}-${randomId}${processedExtension}`;
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.promises.access(dirPath);
    } catch {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }
  }

  private async uploadToLocal(
    processedBuffer: Buffer,
    filename: string,
  ): Promise<UploadResult> {
    const fullPath = path.join(uploadConfig.storage.localPath, filename);
    const dirPath = path.dirname(fullPath);

    await this.ensureDirectoryExists(dirPath);

    // Use streaming for better performance with large files
    const readableStream = Readable.from(processedBuffer);
    const writeStream = fs.createWriteStream(fullPath);

    return new Promise((resolve, reject) => {
      pump(readableStream, writeStream, (error) => {
        if (error) {
          reject(new AppError("Erro ao salvar arquivo localmente", 500));
        } else {
          resolve({
            filename: path.basename(filename),
            path: filename,
            size: processedBuffer.length,
            mimeType: "image/webp",
          });
        }
      });
    });
  }

  private async uploadToR2(
    processedBuffer: Buffer,
    filename: string,
  ): Promise<UploadResult> {
    if (!this.s3) {
      throw new AppError("R2 não foi configurado corretamente", 500);
    }

    // Use streaming for R2 upload for better memory management
    const readableStream = Readable.from(processedBuffer);

    const uploadParams: PutObjectCommandInput = {
      Bucket: uploadConfig.r2.bucket,
      Key: filename,
      Body: readableStream,
      ContentType: "image/webp",
      Metadata: {
        "uploaded-at": new Date().toISOString(),
      },
    };

    try {
      // `Upload` do lib-storage e o equivalente ao `.upload()` do v2: aceita
      // stream e cuida do multipart quando necessario.
      await new Upload({ client: this.s3, params: uploadParams }).done();

      return {
        filename: path.basename(filename),
        path: filename,
        size: processedBuffer.length,
        mimeType: "image/webp",
        url: await this.getFileUrl(filename),
      };
    } catch (error) {
      console.error("Erro ao fazer upload para R2:", error);
      throw new AppError("Erro no upload do arquivo", 500);
    }
  }

  async uploadFile(options: UploadFileOptions): Promise<UploadResult> {
    const { buffer, filename, mimetype, uploadType } = options;

    try {
      // Validate file
      this.validateFile(buffer, mimetype, uploadType);

      // Process image with Sharp
      const processedBuffer = await this.processImage(buffer, uploadType);

      // Generate filename
      const generatedFilename = this.generateFilename(filename, uploadType);

      // Upload based on storage type
      if (uploadConfig.storage.type === "r2") {
        return await this.uploadToR2(processedBuffer, generatedFilename);
      } else {
        return await this.uploadToLocal(processedBuffer, generatedFilename);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error("Erro no serviço de upload:", error);
      throw new AppError("Erro interno no upload do arquivo", 500);
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
      const uploadPrefix = [
        "odometerPhotos/",
        "checklistPhotos/",
        "avatars/",
      ].find((prefix) => candidate.includes(prefix));

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
      // For local development, construct full URL to API server
      const baseUrl = env.API_HTTP_REQUEST || `http://localhost:${env.PORT}`;
      return `${baseUrl}/tmp/${normalizedFilePath}`;
    }
  }

  // Method for streaming upload directly from request without loading all in memory
  async uploadFromStream(options: UploadStreamOptions): Promise<UploadResult> {
    const { stream, filename, mimetype, uploadType, fileSize } = options;

    try {
      // Validate MIME type
      if (!uploadConfig.allowedMimeTypes.images.includes(mimetype)) {
        throw new AppError(
          "Tipo de arquivo não suportado. Use apenas JPEG, JPG, PNG ou WebP.",
          400,
        );
      }

      // Validate file size if provided
      if (fileSize) {
        const maxSize = uploadConfig.getSizeLimit(uploadType);
        if (fileSize > maxSize) {
          const maxSizeMB = maxSize / (1024 * 1024);
          throw new AppError(
            `Arquivo muito grande. Tamanho máximo permitido: ${maxSizeMB}MB`,
            400,
          );
        }
      }

      // Generate filename
      const generatedFilename = this.generateFilename(filename, uploadType);

      // Create Sharp transform stream for processing
      const sharpTransform = sharp({
        limitInputPixels: 40_000_000,
        failOn: "warning",
      })
        .rotate()
        .resize(
          uploadConfig.resize[uploadType].width,
          uploadConfig.resize[uploadType].height,
          {
            fit: uploadConfig.resize[uploadType].fit,
            withoutEnlargement:
              uploadConfig.resize[uploadType].withoutEnlargement,
          },
        )
        .webp({ quality: uploadConfig.quality.webp });

      if (uploadConfig.storage.type === "r2") {
        return await this.uploadStreamToR2(
          stream,
          sharpTransform,
          generatedFilename,
          fileSize,
        );
      } else {
        return await this.uploadStreamToLocal(
          stream,
          sharpTransform,
          generatedFilename,
          fileSize,
        );
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      console.error("Erro no serviço de upload via streaming:", error);
      throw new AppError("Erro interno no upload do arquivo", 500);
    }
  }

  private async uploadStreamToLocal(
    inputStream: NodeJS.ReadableStream,
    sharpTransform: sharp.Sharp,
    filename: string,
    fileSize?: number,
  ): Promise<UploadResult> {
    const fullPath = path.join(uploadConfig.storage.localPath, filename);
    const dirPath = path.dirname(fullPath);

    await this.ensureDirectoryExists(dirPath);

    const writeStream = fs.createWriteStream(fullPath);

    return new Promise((resolve, reject) => {
      let processedSize = 0;

      pump(inputStream, sharpTransform, writeStream, (error) => {
        if (error) {
          reject(
            new AppError("Erro ao processar e salvar arquivo localmente", 500),
          );
        } else {
          resolve({
            filename: path.basename(filename),
            path: filename,
            size: processedSize || fileSize || 0,
            mimeType: "image/webp",
          });
        }
      });

      // Track processed size
      sharpTransform.on("data", (chunk) => {
        processedSize += chunk.length;
      });
    });
  }

  private async uploadStreamToR2(
    inputStream: NodeJS.ReadableStream,
    sharpTransform: sharp.Sharp,
    filename: string,
    fileSize?: number,
  ): Promise<UploadResult> {
    if (!this.s3) {
      throw new AppError("R2 não foi configurado corretamente", 500);
    }

    return new Promise((resolve, reject) => {
      let processedSize = 0;

      // Create pipeline: input -> sharp processing -> R2
      const processedStream = inputStream.pipe(sharpTransform);

      // Track processed size
      processedStream.on("data", (chunk) => {
        processedSize += chunk.length;
      });

      const uploadParams: PutObjectCommandInput = {
        Bucket: uploadConfig.r2.bucket,
        Key: filename,
        Body: processedStream,
        ContentType: "image/webp",
        Metadata: {
          "uploaded-at": new Date().toISOString(),
        },
      };

      // O v3 nao tem a variante por callback: `Upload.done()` devolve Promise.
      new Upload({ client: this.s3!, params: uploadParams })
        .done()
        .then(async () => {
          resolve({
            filename: path.basename(filename),
            path: filename,
            size: processedSize || fileSize || 0,
            mimeType: "image/webp",
            url: await this.getFileUrl(filename),
          });
        })
        .catch(() => {
          reject(new AppError("Erro no upload para R2", 500));
        });
    });
  }
}

export { UploadService };
