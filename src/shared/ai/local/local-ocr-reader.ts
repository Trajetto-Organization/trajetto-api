import { z } from "zod";

import {
  InvalidModelResponseError,
  parseModelAnswer,
  type AnswerByKind,
} from "../ai-answers";
import type { ProviderCall, ProviderCallUsage } from "../ai-types";
import type {
  ImageReader,
  ReadTarget,
  ReadingKind,
  StoredImage,
} from "../image-reader";
import { PaidInvalidResponseError } from "../reader-errors";
import type { ProviderFailureKind } from "../vision-provider";

import {
  OCR_RULES_VERSION,
  odometerFromLines,
  proofFromLines,
  type OcrLine,
} from "./ocr-readings";

/**
 * The trajetto-ai service (infra/ai-ocr, ADR 0010 §3) as the pipeline's
 * reader: the photo goes as raw bytes to POST /v1/read, the lines come back
 * and ocr-readings.ts turns them into the product's answer, validated by the
 * same schema a model's answer is (a porting bug in the rules surfaces as an
 * invalid answer, never as a verdict).
 *
 * Only the receipt and the odometer: fuel level, tyre condition and the
 * "working" items are not OCR questions, so they create no unit and spend
 * no quota (supports()).
 */

type OcrProfile = "receipt" | "digits";

/** Which engine profile reads which kind (the benchmark's "combo"). */
const PROFILE_BY_KIND: Partial<Record<ReadingKind, OcrProfile>> = {
  proof: "receipt",
  odometer: "digits",
};

const ENGINE_LABEL = "rapidocr-3.9.2/ppocrv5m+ppocrv6s";

const readResponseSchema = z.object({
  lines: z.array(
    z.object({
      text: z.string(),
      score: z.number(),
      box: z.array(z.array(z.number()).length(2)).length(4),
    }),
  ),
  engine: z.string().optional(),
  engineVersion: z.string().optional(),
});

/**
 * An answer of the service that is not a 2xx. The message STARTS with the
 * status: it becomes the request's lastError, and the ops credential alert
 * (operational-snapshot.ts, AI_CREDENTIAL_PATTERN "^40[13][^0-9]") finds a
 * refused AI_LOCAL_TOKEN by that prefix.
 */
class LocalOcrHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(
      `${status}${code ? ` ${code}` : ""}: ${
        status === 401 || status === 403
          ? "o serviço de IA local recusou o token (confira AI_LOCAL_TOKEN na API e no trajetto-ai)"
          : "resposta do serviço de IA local"
      }`,
    );
    this.name = "LocalOcrHttpError";
  }
}

/** A kind this reader does not answer was asked for: a bug, not an outage. */
class UnsupportedReadingError extends Error {
  constructor(kind: string) {
    super(`unsupported_by_reader: ${kind}`);
    this.name = "UnsupportedReadingError";
  }
}

interface LocalOcrReaderOptions {
  url: string;
  token: string;
  timeoutMs: number;
  maxConcurrency: number;

  /** Injectable for the unit tests' in-memory server. */
  fetchImpl?: typeof fetch;
}

class LocalOcrReader implements ImageReader {
  readonly name = "local";
  readonly model = ENGINE_LABEL;

  /** No retry in the client: the pipeline's backoff does that (ADR 0010 §3.2). */
  readonly maxRetries = 0;

  readonly timeoutMs: number;
  readonly maxConcurrency: number;

  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalOcrReaderOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.maxConcurrency = options.maxConcurrency;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  supports(kind: ReadingKind): boolean {
    return PROFILE_BY_KIND[kind] !== undefined;
  }

  async read<T extends ReadTarget>(
    target: T,
    image: StoredImage,
  ): Promise<ProviderCall<AnswerByKind[T["kind"]]>> {
    const profile = PROFILE_BY_KIND[target.kind];

    if (!profile) throw new UnsupportedReadingError(target.kind);

    const startedAt = Date.now();

    const response = await this.fetchImpl(
      `${this.url}/v1/read?profile=${profile}`,
      {
        method: "POST",
        headers: {
          // Never logged; the error messages below never carry it either.
          Authorization: `Bearer ${this.token}`,
          "Content-Type": image.mediaType,
        },
        body: image.bytes,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const code =
        body &&
        typeof body === "object" &&
        typeof (body as { error?: unknown }).error === "string"
          ? String((body as { error: string }).error).slice(0, 40)
          : null;

      throw new LocalOcrHttpError(response.status, code);
    }

    const usage: ProviderCallUsage = {
      provider: this.name,
      model: `rapidocr-${
        (body as { engineVersion?: unknown } | null)?.engineVersion ?? "?"
      }/${profile}/rules-v${OCR_RULES_VERSION}`.slice(0, 120),
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - startedAt,
    };

    const parsedBody = readResponseSchema.safeParse(body);

    if (!parsedBody.success) {
      throw new PaidInvalidResponseError(
        new InvalidModelResponseError(
          "resposta do serviço de OCR fora do contrato",
        ).message,
        usage,
      );
    }

    const lines: OcrLine[] = parsedBody.data.lines;

    const answer =
      target.kind === "proof"
        ? proofFromLines(lines)
        : odometerFromLines(lines);

    try {
      return {
        parsed: parseModelAnswer(
          target.kind,
          JSON.stringify(answer),
        ) as AnswerByKind[T["kind"]],
        usage,
      };
    } catch (error) {
      if (error instanceof InvalidModelResponseError) {
        throw new PaidInvalidResponseError(error.message, usage);
      }

      throw error;
    }
  }

  /**
   * What a failure means for the pipeline (ADR 0010 §3.2):
   * 503 = busy (back-pressure); 401 = token; 400/413 = this photo;
   * refused/timeout/5xx = retryable (five in a row open the circuit).
   */
  classifyError(error: unknown): ProviderFailureKind {
    if (error instanceof LocalOcrHttpError) {
      if (error.status === 503) return "busy";
      if (error.status === 401 || error.status === 403) return "unauthorized";
      if (error.status === 400 || error.status === 413) return "permanent";

      // 404 (wrong URL), 500, 502, 504: the service, not the photo.
      return "retryable";
    }

    if (error instanceof UnsupportedReadingError) return "permanent";

    // AbortSignal.timeout, a refused or reset connection, DNS: transient.
    // Anything unknown is treated the same: the circuit opens on a streak.
    return "retryable";
  }
}

export {
  ENGINE_LABEL,
  LocalOcrHttpError,
  LocalOcrReader,
  PROFILE_BY_KIND,
  UnsupportedReadingError,
};
export type { LocalOcrReaderOptions, OcrProfile };
