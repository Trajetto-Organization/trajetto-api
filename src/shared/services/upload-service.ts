import { injectable } from "tsyringe";

import sharp from "sharp";
import AWS from "aws-sdk";

import fs from "node:fs";
import path from "node:path";

import { Readable } from "node:stream";
import pump from "pump";

import { uploadConfig, UploadType } from "@/config/upload";
import { v4 as uuid } from "uuid";

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
  private s3?: AWS.S3;

  constructor() {
    if (uploadConfig.storage.type === "s3") {
      this.s3 = new AWS.S3({
        accessKeyId: uploadConfig.aws.accessKeyId,
        secretAccessKey: uploadConfig.aws.secretAccessKey,
        region: uploadConfig.aws.region,
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

    let sharpInstance = sharp(buffer).resize(config.width, config.height, {
      fit: config.fit,
      withoutEnlargement: config.withoutEnlargement,
    });

    // Convert to WebP for better compression while maintaining quality
    sharpInstance = sharpInstance
      .webp({ quality: uploadConfig.quality.webp })
      .withMetadata(); // Preserve metadata

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
      .substring(0, 20); // Limit to 20 characters

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

  private async uploadToS3(
    processedBuffer: Buffer,
    filename: string,
  ): Promise<UploadResult> {
    if (!this.s3) {
      throw new AppError("S3 não foi configurado corretamente", 500);
    }

    // Use streaming for S3 upload for better memory management
    const readableStream = Readable.from(processedBuffer);

    const uploadParams: AWS.S3.PutObjectRequest = {
      Bucket: uploadConfig.aws.bucket,
      Key: filename,
      Body: readableStream,
      ContentType: "image/webp",
      ACL: "public-read",
      Metadata: {
        "uploaded-at": new Date().toISOString(),
      },
    };

    try {
      const result = await this.s3.upload(uploadParams).promise();

      return {
        filename: path.basename(filename),
        path: filename,
        size: processedBuffer.length,
        mimeType: "image/webp",
        url: result.Location,
      };
    } catch (error) {
      console.error("Erro ao fazer upload para S3:", error);
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
      if (uploadConfig.storage.type === "s3") {
        return await this.uploadToS3(processedBuffer, generatedFilename);
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
      if (uploadConfig.storage.type === "s3") {
        if (!this.s3) {
          throw new AppError("S3 não foi configurado corretamente", 500);
        }

        await this.s3
          .deleteObject({
            Bucket: uploadConfig.aws.bucket,
            Key: filePath,
          })
          .promise();
      } else {
        const fullPath = path.join(uploadConfig.storage.localPath, filePath);
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

  getFileUrl(filePath: string): string {
    if (uploadConfig.storage.type === "s3") {
      return `https://${uploadConfig.aws.bucket}.s3.${uploadConfig.aws.region}.amazonaws.com/${filePath}`;
    } else {
      // For local development, you might want to serve files through your API
      return `/uploads/${filePath}`;
    }
  }

  // Method for streaming upload directly from request without loading all in memory
  async uploadFromStream(options: UploadStreamOptions): Promise<UploadResult> {
    const { stream, filename, mimetype, uploadType, fileSize } = options;

    try {
      // Validate MIME type
      if (!uploadConfig.allowedMimeTypes.images.includes(mimetype)) {
        throw new AppError(
          "Tipo de arquivo não suportado. Use apenas JPEG, PNG ou WebP.",
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
      const sharpTransform = sharp()
        .resize(
          uploadConfig.resize[uploadType].width,
          uploadConfig.resize[uploadType].height,
          {
            fit: uploadConfig.resize[uploadType].fit,
            withoutEnlargement:
              uploadConfig.resize[uploadType].withoutEnlargement,
          },
        )
        .webp({ quality: uploadConfig.quality.webp })
        .withMetadata();

      if (uploadConfig.storage.type === "s3") {
        return await this.uploadStreamToS3(
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

  private async uploadStreamToS3(
    inputStream: NodeJS.ReadableStream,
    sharpTransform: sharp.Sharp,
    filename: string,
    fileSize?: number,
  ): Promise<UploadResult> {
    if (!this.s3) {
      throw new AppError("S3 não foi configurado corretamente", 500);
    }

    return new Promise((resolve, reject) => {
      let processedSize = 0;

      // Create pipeline: input -> sharp processing -> S3
      const processedStream = inputStream.pipe(sharpTransform);

      // Track processed size
      processedStream.on("data", (chunk) => {
        processedSize += chunk.length;
      });

      const uploadParams: AWS.S3.PutObjectRequest = {
        Bucket: uploadConfig.aws.bucket,
        Key: filename,
        Body: processedStream,
        ContentType: "image/webp",
        ACL: "public-read",
        Metadata: {
          "uploaded-at": new Date().toISOString(),
        },
      };

      this.s3?.upload(uploadParams, (error, result) => {
        if (error) {
          reject(new AppError("Erro no upload para S3", 500));
        } else {
          resolve({
            filename: path.basename(filename),
            path: filename,
            size: processedSize || fileSize || 0,
            mimeType: "image/webp",
            url: result.Location,
          });
        }
      });
    });
  }
}

export { UploadService };
