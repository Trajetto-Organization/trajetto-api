import type { AnswerByKind } from "./ai-answers";
import type { ChecklistFieldSpec } from "./ai-prompts";
import type { ProviderCall } from "./ai-types";
import type { ImageMediaType, ProviderFailureKind } from "./vision-provider";

/**
 * The seam between the AI pipeline and whoever reads the photo (ADR 0010,
 * rewritten 05/10/2026).
 *
 * It used to be a vision model (image + prompt -> text). OCR takes no prompt,
 * so the seam moved one level up: a reader turns a stored photo into the
 * product's ANSWER for one kind of reading, already validated by the
 * product's schema (ai-answers.ts). What the answer means for the record —
 * compared with what the driver informed or the delivery expected — stays in
 * ai-rules.ts, the same for every reader.
 *
 * - LocalOcrReader (local/local-ocr-reader.ts): the only one in production.
 *   Reads the receipt and the odometer; nothing else.
 * - VisionModelReader (vision-model-reader.ts): a VisionProvider with the
 *   blind prompts, kept for a dedicated VLM box; no provider ships today.
 * - FakeImageReader (testing/fake-image-reader.ts): the tests' double.
 */

/** What a photo is read for: the receipt, the odometer, or a checklist item. */
type ReadingKind =
  | "proof"
  | "odometer"
  | "fuel_level"
  | "condition"
  | "working";

/**
 * The reading asked for. A checklist item carries its spec (subject, hint),
 * which a vision model needs for its prompt and OCR ignores.
 */
type ReadTarget = { kind: "proof" } | ChecklistFieldSpec;

/** The photo as storage holds it. */
interface StoredImage {
  bytes: Buffer;
  mediaType: ImageMediaType;
}

interface ImageReader {
  /** Recorded on AIProviderAttempt.provider. */
  readonly name: string;

  /** The engine/model, e.g. "rapidocr-3.9.2/ppocrv5m+ppocrv6s". */
  readonly model: string;

  /** The per-call budget, checked against the lease when the pipeline loads. */
  readonly timeoutMs: number;
  readonly maxRetries: number;

  /** Reads in flight per replica; the pipeline takes min(AI_CONCURRENCY, this). */
  readonly maxConcurrency: number;

  isConfigured(): boolean;

  /**
   * Whether this reader answers this kind at all. A kind it does not cover
   * creates no unit and spends no quota (ADR 0010 §5).
   */
  supports(kind: ReadingKind): boolean;

  read<T extends ReadTarget>(
    target: T,
    image: StoredImage,
  ): Promise<ProviderCall<AnswerByKind[T["kind"]]>>;

  classifyError(error: unknown): ProviderFailureKind;
}

export type { ImageReader, ReadTarget, ReadingKind, StoredImage };
