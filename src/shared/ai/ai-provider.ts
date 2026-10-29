import { env } from "@/env";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import fs from "node:fs";
import path from "node:path";

import type { AnswerByKind } from "./ai-answers";
import type { ChecklistFieldSpec } from "./ai-prompts";
import {
  LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  LOCAL_AI_DEFAULT_TIMEOUT_MS,
} from "./ai-provider-defaults";
import type { ProviderCall } from "./ai-types";
import type {
  ImageReader,
  ReadTarget,
  ReadingKind,
  StoredImage,
} from "./image-reader";
import { LocalOcrReader } from "./local/local-ocr-reader";
import {
  providerErrorKind,
  providerMetrics,
} from "@/shared/health/provider-metrics";
import {
  ImageUnavailableError,
  PaidInvalidResponseError,
} from "./reader-errors";
import type { ImageMediaType, ProviderFailureKind } from "./vision-provider";

/** The photo read from storage before the call; a stuck GET must not hang either. */
const AI_IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** Loads a stored photo for the reader; injectable so tests need no storage. */
type ImageLoader = (storagePath: string) => Promise<StoredImage>;

// ============================================================================
// Configuration (ADR 0010, rewritten 05/10/2026)
// ============================================================================

interface AIProviderConfig {
  AI_PROVIDER: "local" | "none";
  AI_LOCAL_URL?: string;
  AI_LOCAL_TOKEN?: string;
  AI_LOCAL_TIMEOUT_MS?: number;
  AI_LOCAL_MAX_CONCURRENCY?: number;
}

/** The reader the environment selects, or null when the readings are off. */
function createConfiguredImageReader(
  config: AIProviderConfig = env,
): ImageReader | null {
  if (!aiProviderConfigured(config)) return null;

  return new LocalOcrReader({
    url: config.AI_LOCAL_URL!,
    token: config.AI_LOCAL_TOKEN!,
    timeoutMs: config.AI_LOCAL_TIMEOUT_MS ?? LOCAL_AI_DEFAULT_TIMEOUT_MS,
    maxConcurrency:
      config.AI_LOCAL_MAX_CONCURRENCY ?? LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  });
}

/**
 * Whether analyses can be requested at all. The one gate for the service, the
 * proof sweep, the progress route and the pipeline. `local` without a URL or
 * a token behaves as `none`: the records are marked skipped, nothing queues.
 */
function aiProviderConfigured(config: AIProviderConfig = env): boolean {
  return (
    config.AI_PROVIDER === "local" &&
    Boolean(config.AI_LOCAL_URL && config.AI_LOCAL_TOKEN)
  );
}

// ============================================================================
// Images
// ============================================================================

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

let s3Client: S3Client | null = null;

function storageClient(): S3Client | null {
  if (env.UPLOAD_STORAGE_TYPE !== "r2" || !env.R2_ACCOUNT_ID) return null;

  s3Client ??= new S3Client({
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID || "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
    },
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: AI_IMAGE_FETCH_TIMEOUT_MS,
    },
  });

  return s3Client;
}

/**
 * The photo from R2 (production) or the local upload folder (development),
 * as bytes: the OCR service takes them as the request body; only a vision
 * model needs base64, and VisionModelReader computes it.
 */
const loadStoredImage: ImageLoader = async (storagePath) => {
  let buffer: Buffer;
  const s3 = storageClient();

  if (s3) {
    // One deadline over the request AND the body: the handler's
    // requestTimeout is a socket idle timeout, which a slow trickle of bytes
    // never trips.
    const abortSignal = AbortSignal.timeout(AI_IMAGE_FETCH_TIMEOUT_MS);

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: env.R2_BUCKET_NAME || "",
        Key: storagePath,
      }),
      { abortSignal },
    );

    buffer = Buffer.from(await result.Body!.transformToByteArray());
  } else {
    const fullPath = path.join(
      path.resolve(env.UPLOAD_LOCAL_PATH),
      storagePath,
    );
    buffer = await fs.promises.readFile(fullPath);
  }

  return {
    bytes: buffer,
    mediaType:
      MEDIA_TYPES[path.extname(storagePath).toLowerCase()] || "image/webp",
  };
};

// ============================================================================
// The analyzer
// ============================================================================

/**
 * Reads a photo for the pipeline: loads it and hands it to the reader, which
 * answers in the product's validated shape (ai-answers.ts). Reader-agnostic:
 * OCR in production, a vision model or a fake in tests.
 *
 * Transport failures and invalid answers THROW. The pipeline records the
 * attempt and decides with `classifyError` whether to retry, wait (busy),
 * give the unit back or pause; an invalid answer carries the usage of the
 * call that produced it.
 */
class AIAnalysisProvider {
  constructor(
    private reader: ImageReader | null = createConfiguredImageReader(),
    private loadImage: ImageLoader = loadStoredImage,
  ) {}

  isAvailable(): boolean {
    return this.reader !== null && this.reader.isConfigured();
  }

  get providerName(): string {
    return this.reader?.name ?? "none";
  }

  get model(): string {
    return this.reader?.model ?? "none";
  }

  /** Reads in flight this reader takes per replica. */
  get maxConcurrency(): number {
    return this.reader?.maxConcurrency ?? 1;
  }

  /** The per-call budget the lease has to cover. */
  budget(): { timeoutMs: number; maxRetries: number } {
    return {
      timeoutMs: this.reader?.timeoutMs ?? 0,
      maxRetries: this.reader?.maxRetries ?? 0,
    };
  }

  /** Whether the reader answers this kind; no reader answers nothing. */
  supports(kind: ReadingKind): boolean {
    return this.reader?.supports(kind) ?? false;
  }

  classifyError(error: unknown): ProviderFailureKind {
    return this.reader?.classifyError(error) ?? "retryable";
  }

  analyzeOdometerImage(
    imagePath: string,
  ): Promise<ProviderCall<AnswerByKind["odometer"]>> {
    return this.read(imagePath, { kind: "odometer", subject: "o odômetro" });
  }

  analyzeChecklistImage<K extends ChecklistFieldSpec["kind"]>(
    imagePath: string,
    spec: ChecklistFieldSpec & { kind: K },
  ): Promise<ProviderCall<AnswerByKind[K]>> {
    return this.read(imagePath, spec);
  }

  analyzeDeliveryProof(
    imagePath: string,
  ): Promise<ProviderCall<AnswerByKind["proof"]>> {
    return this.read(imagePath, { kind: "proof" });
  }

  private async read<T extends ReadTarget>(
    imagePath: string,
    target: T,
  ): Promise<ProviderCall<AnswerByKind[T["kind"]]>> {
    if (!this.reader || !this.reader.isConfigured()) {
      throw new Error("AI reader not configured");
    }

    let image: StoredImage;

    try {
      image = await this.loadImage(imagePath);
    } catch (error) {
      throw new ImageUnavailableError(imagePath, error);
    }

    // Timed per call for /health/metrics. Only the reader's call: loading the
    // photo from storage is not the OCR service's latency. The kind is the
    // pipeline's own classification (busy, retryable, ...), never a message.
    const reader = this.reader;
    const startedAt = performance.now();

    try {
      const call = await reader.read(target, image);

      providerMetrics.record("AI_OCR", performance.now() - startedAt, true);

      return call;
    } catch (error) {
      let kind: string;

      try {
        kind = reader.classifyError(error);
      } catch {
        kind = providerErrorKind(error);
      }

      providerMetrics.record(
        "AI_OCR",
        performance.now() - startedAt,
        false,
        kind,
      );

      throw error;
    }
  }
}

export {
  AIAnalysisProvider,
  AI_IMAGE_FETCH_TIMEOUT_MS,
  ImageUnavailableError,
  PaidInvalidResponseError,
  aiProviderConfigured,
  createConfiguredImageReader,
  loadStoredImage,
};
export type { AIProviderConfig, ImageLoader, ProviderCall };
