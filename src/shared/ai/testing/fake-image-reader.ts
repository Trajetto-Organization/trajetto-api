import { answerSchemas, type AnswerByKind } from "../ai-answers";
import type { ProviderCall, ProviderCallUsage } from "../ai-types";
import type {
  ImageReader,
  ReadTarget,
  ReadingKind,
  StoredImage,
} from "../image-reader";
import type { ProviderFailureKind } from "../vision-provider";

/**
 * The tests' reader: answers per kind, failures to inject, and the kinds it
 * covers. Nothing here reaches the network. The answers go through the
 * product's schema, so a test cannot hand the pipeline a shape the real
 * readers could never produce.
 */

type Failure =
  | "busy"
  | "retryable"
  | "unauthorized"
  | "permanent"
  | "quota_exhausted";

class FakeReaderFailure extends Error {
  constructor(readonly kind: Failure) {
    super(`fake reader failure: ${kind}`);
    this.name = "FakeReaderFailure";
  }
}

type FakeAnswers = {
  [K in keyof AnswerByKind]?:
    | Record<string, unknown>
    | ((photoPath: string) => Record<string, unknown>);
};

interface FakeImageReaderOptions {
  answers?: FakeAnswers;

  /**
   * One entry per call, in order: the failure to throw, or null for a call
   * that answers. Calls beyond the list answer.
   */
  failures?: Array<Failure | null>;

  /** Awaited inside every call (to hold a read in flight). */
  onRead?: () => Promise<void>;

  /** The kinds it reads; every kind when absent. */
  supports?: ReadingKind[];

  maxConcurrency?: number;
  timeoutMs?: number;
}

const FAKE_READER_USAGE: ProviderCallUsage = {
  provider: "fake-reader",
  model: "fake-reader",
  inputTokens: null,
  outputTokens: null,
  durationMs: 1,
};

class FakeImageReader implements ImageReader {
  readonly name = "fake-reader";
  readonly model = "fake-reader";
  readonly maxRetries = 0;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;

  /** Every call, in order: what was asked and for which photo. */
  readonly calls: Array<{ kind: string; photoPath: string }> = [];

  private failures: Array<Failure | null>;
  private covered: Set<ReadingKind> | null;

  constructor(private options: FakeImageReaderOptions = {}) {
    this.failures = [...(options.failures ?? [])];
    this.covered = options.supports ? new Set(options.supports) : null;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.maxConcurrency = options.maxConcurrency ?? 4;
  }

  isConfigured(): boolean {
    return true;
  }

  supports(kind: ReadingKind): boolean {
    return this.covered === null || this.covered.has(kind);
  }

  /** Queues more outcomes for the next calls (null = answers). */
  failNext(...failures: Array<Failure | null>): void {
    this.failures.push(...failures);
  }

  async read<T extends ReadTarget>(
    target: T,
    image: StoredImage,
  ): Promise<ProviderCall<AnswerByKind[T["kind"]]>> {
    // The fake loader hands the storage path as the bytes.
    const photoPath = image.bytes.toString();
    this.calls.push({ kind: target.kind, photoPath });

    await this.options.onRead?.();

    const failure = this.failures.shift();
    if (failure) throw new FakeReaderFailure(failure);

    const answer = this.options.answers?.[target.kind];

    if (!answer) {
      throw new Error(`FakeImageReader has no answer for "${target.kind}"`);
    }

    const raw = typeof answer === "function" ? answer(photoPath) : answer;

    return {
      parsed: answerSchemas[target.kind].parse(raw) as AnswerByKind[T["kind"]],
      usage: FAKE_READER_USAGE,
    };
  }

  classifyError(error: unknown): ProviderFailureKind {
    return error instanceof FakeReaderFailure ? error.kind : "retryable";
  }
}

/** The loader the fake expects: the "photo" is its own storage path. */
async function fakeImageLoader(storagePath: string): Promise<StoredImage> {
  return { bytes: Buffer.from(storagePath), mediaType: "image/jpeg" };
}

export {
  FAKE_READER_USAGE,
  FakeImageReader,
  FakeReaderFailure,
  fakeImageLoader,
};
export type { FakeImageReaderOptions };
