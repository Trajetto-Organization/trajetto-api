import {
  InvalidModelResponseError,
  parseModelAnswer,
  type AnswerByKind,
} from "./ai-answers";
import {
  checklistFieldPrompt,
  odometerPrompt,
  proofExtractionPrompt,
} from "./ai-prompts";
import type { ProviderCall } from "./ai-types";
import type {
  ImageReader,
  ReadTarget,
  ReadingKind,
  StoredImage,
} from "./image-reader";
import { PaidInvalidResponseError } from "./reader-errors";
import type { ProviderFailureKind, VisionProvider } from "./vision-provider";

/** A JSON answer of a dozen keys; room for a verbose model, not for an essay. */
const AI_MAX_OUTPUT_TOKENS = 500;

/** Requests in flight per replica for a remote model (the old pool size). */
const VISION_MODEL_MAX_CONCURRENCY = 4;

/**
 * A vision model as a reader: the BLIND prompt of the reading (ai-prompts.ts),
 * the model's text validated by the product's schema (ai-answers.ts).
 *
 * No VisionProvider ships with the product since ADR 0010 (05/10/2026): this
 * is the slot for a dedicated VLM box, and what the tests use to drive the
 * pipeline with model-shaped answers. A model reads every kind.
 */
class VisionModelReader implements ImageReader {
  readonly maxConcurrency = VISION_MODEL_MAX_CONCURRENCY;

  constructor(private provider: VisionProvider) {}

  get name(): string {
    return this.provider.name;
  }

  get model(): string {
    return this.provider.model;
  }

  get timeoutMs(): number {
    return this.provider.timeoutMs;
  }

  get maxRetries(): number {
    return this.provider.maxRetries;
  }

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  supports(_kind: ReadingKind): boolean {
    return true;
  }

  classifyError(error: unknown): ProviderFailureKind {
    return this.provider.classifyError(error);
  }

  async read<T extends ReadTarget>(
    target: T,
    image: StoredImage,
  ): Promise<ProviderCall<AnswerByKind[T["kind"]]>> {
    const prompt =
      target.kind === "proof"
        ? proofExtractionPrompt()
        : target.kind === "odometer"
          ? odometerPrompt()
          : checklistFieldPrompt(target);

    const { text, usage } = await this.provider.complete({
      // Only a model wants base64; OCR gets the bytes as they are.
      image: { base64: image.bytes.toString("base64"), mediaType: image.mediaType },
      prompt,
      maxTokens: AI_MAX_OUTPUT_TOKENS,
    });

    try {
      return {
        parsed: parseModelAnswer(target.kind, text) as AnswerByKind[T["kind"]],
        usage,
      };
    } catch (error) {
      if (error instanceof InvalidModelResponseError) {
        throw new PaidInvalidResponseError(error.message, usage);
      }

      throw error;
    }
  }
}

export { AI_MAX_OUTPUT_TOKENS, VisionModelReader };
