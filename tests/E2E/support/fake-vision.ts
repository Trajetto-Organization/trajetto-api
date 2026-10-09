import { AIAnalysisProvider } from "@/shared/ai/ai-provider";
import { ProviderCircuit } from "@/shared/ai/provider-circuit";
import { classifyProviderFailure } from "@/shared/ai/provider-failure";
import type { ProviderCallUsage } from "@/shared/ai/ai-types";
import { VisionModelReader } from "@/shared/ai/vision-model-reader";
import type {
  ProviderFailureKind,
  VisionProvider,
  VisionRequest,
} from "@/shared/ai/vision-provider";

/**
 * The AI pipeline's reader, faked (ADR 0010). Nothing here reaches the
 * network.
 *
 * - `fakeVision(answer)` is a vision MODEL behind the real VisionModelReader:
 *   the real reader builds the prompt, and the real schema validates the
 *   TEXT the fake answers. `answer` receives the prompt and the photo's
 *   storage path. It reads every kind, as a model does.
 * - `fakeAnalyzer(methods)` replaces the analyzer's three reads with parsed
 *   answers, for the tests about the queue mechanics (lease, fairness) that do
 *   not care what was read.
 * - For OCR-shaped coverage (only the receipt and the odometer) and injected
 *   busy/unauthorized failures, use FakeImageReader
 *   (src/shared/ai/testing/fake-image-reader.ts).
 *
 * A thrown FakeProviderError is classified by the provider-agnostic rule
 * (provider-failure.ts) from its status and body, as a real provider's would.
 */

const FAKE_USAGE: ProviderCallUsage = {
  provider: "fake",
  model: "fake-vision",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
};

/** A provider's HTTP refusal, as facts: status, error type and code. */
class FakeProviderError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly errorType: string | null = null,
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = "FakeProviderError";
  }
}

function classify(error: unknown): ProviderFailureKind {
  if (!(error instanceof FakeProviderError)) return "retryable";

  return classifyProviderFailure({
    status: error.status,
    errorType: error.errorType,
    errorCode: error.errorCode,
    message: error.message,
  });
}

type Answer = (
  request: VisionRequest & { photoPath: string },
) => Promise<string> | string;

class FakeVisionProvider implements VisionProvider {
  readonly name = "fake";
  readonly model = "fake-vision";
  readonly timeoutMs = 1_000;
  readonly maxRetries = 0;

  constructor(private answer: Answer) {}

  isConfigured(): boolean {
    return true;
  }

  async complete(request: VisionRequest) {
    const photoPath = Buffer.from(request.image.base64, "base64").toString();

    return {
      text: await this.answer({ ...request, photoPath }),
      usage: FAKE_USAGE,
    };
  }

  classifyError(error: unknown): ProviderFailureKind {
    return classify(error);
  }
}

/** The real analyzer over a fake model; the "photo" is its own path. */
function fakeVision(answer: Answer): AIAnalysisProvider {
  return new AIAnalysisProvider(
    new VisionModelReader(new FakeVisionProvider(answer)),
    async (path) => ({ bytes: Buffer.from(path), mediaType: "image/jpeg" }),
  );
}

function fakeAnalyzer(methods: Record<string, unknown>) {
  return {
    providerName: "fake",
    model: "fake-vision",
    classifyError: classify,
    ...methods,
  };
}

/** A pipeline with its circuit closed, for tests that share the singleton. */
function resetCircuit(pipeline: unknown): void {
  (pipeline as { circuit: ProviderCircuit }).circuit = new ProviderCircuit();
}

export { FAKE_USAGE, FakeProviderError, fakeAnalyzer, fakeVision, resetCircuit };
