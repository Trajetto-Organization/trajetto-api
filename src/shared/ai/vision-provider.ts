import type { ProviderCallUsage } from "./ai-types";

/**
 * A vision MODEL: (image, prompt) -> text (ADR 0010).
 *
 * Since the rewrite of 05/10/2026 the pipeline's seam is the reader
 * (image-reader.ts): the product reads with OCR (local/local-ocr-reader.ts),
 * which takes no prompt. A vision model plugs in through VisionModelReader,
 * which keeps the blind prompts and the answer validation, so a dedicated
 * box for a small VLM (ADR 0010 §3, item 4) is one VisionProvider class and
 * configuration, not a rewrite. No concrete provider ships today.
 */

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface VisionImage {
  base64: string;
  mediaType: ImageMediaType;
}

interface VisionRequest {
  image: VisionImage;
  prompt: string;
  maxTokens: number;
}

interface VisionResponse {
  text: string;
  usage: ProviderCallUsage;
}

/**
 * What a failed call means for the pipeline.
 *
 * - `retryable`: rate limit, server error, overload, network, timeout. The
 *   request goes back to the queue with the backoff.
 * - `permanent`: this call will never work (malformed request, unknown
 *   model, image too large). The unit is given back without retrying.
 * - `unauthorized`: the key was refused (401/403). Fails the request, so the
 *   credential alert fires, and pauses the pipeline so the backlog is not
 *   failed with it.
 * - `quota_exhausted`: the provider's spend limit, our own usage limit on the
 *   provider, or billing. Nothing is wrong with the request: it goes back to
 *   the queue WITHOUT spending an attempt, and the pipeline pauses.
 * - `busy`: the reader is up but its own small queue is full (the OCR
 *   service's 503). Back-pressure, not a failure: the request goes back to
 *   the queue in 5–15 s without spending an attempt and without touching the
 *   circuit (ADR 0010 §3.2).
 */
type ProviderFailureKind =
  | "retryable"
  | "permanent"
  | "unauthorized"
  | "quota_exhausted"
  | "busy";

interface VisionProvider {
  /** Recorded on every AIProviderAttempt. */
  readonly name: string;
  readonly model: string;

  /** The per-call budget, checked against the lease when the pipeline loads. */
  readonly timeoutMs: number;
  readonly maxRetries: number;

  isConfigured(): boolean;

  complete(request: VisionRequest): Promise<VisionResponse>;

  classifyError(error: unknown): ProviderFailureKind;
}

export type {
  ImageMediaType,
  ProviderFailureKind,
  VisionImage,
  VisionProvider,
  VisionRequest,
  VisionResponse,
};
