import {
  INPUT_SUPERSEDED_MARKER,
  INVALID_RESPONSE_MARKER,
  PROVIDER_PAUSED_MARKER,
} from "@/shared/ai/provider-failure";

/**
 * Why the latest request of a record is waiting or ended the way it did, as
 * the progress route tells the tenant (AI-8).
 *
 * The route used to hand back the request's lastError as stored: the
 * provider's own error text — its wording, sometimes its organisation's
 * limits — to anybody allowed to read the record, drivers included; and the
 * web told a paused reading from a failing one by that free text's prefix.
 * The code is the contract; the message is ours, fixed, in pt-BR.
 */
type ProgressErrorCode =
  | "AI_PROVIDER_PAUSED"
  | "AI_INPUT_SUPERSEDED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_INVALID_RESPONSE"
  | "AI_ANALYSIS_ERROR";

const PROGRESS_ERROR_CODES: ProgressErrorCode[] = [
  "AI_PROVIDER_PAUSED",
  "AI_INPUT_SUPERSEDED",
  "AI_QUOTA_EXCEEDED",
  "AI_INVALID_RESPONSE",
  "AI_ANALYSIS_ERROR",
];

interface ProgressError {
  code: ProgressErrorCode;
  message: string;
}

/** The quota's refusal, as ai-analysis-service records it. */
const QUOTA_DENIED_PREFIX = "Limite de análises";

const PAUSED_MESSAGE =
  "O provedor de IA recusou o serviço; a leitura será retomada automaticamente.";

function progressError(
  status: string,
  lastError: string | null | undefined,
): ProgressError | null {
  if (!lastError) return null;

  if (lastError.startsWith(PROVIDER_PAUSED_MARKER)) {
    return { code: "AI_PROVIDER_PAUSED", message: PAUSED_MESSAGE };
  }

  if (lastError.startsWith(INPUT_SUPERSEDED_MARKER)) {
    return {
      code: "AI_INPUT_SUPERSEDED",
      message:
        "A foto ou o valor do registro mudou antes da leitura; o que está no registro agora tem a sua própria análise.",
    };
  }

  if (status === "SKIPPED" && lastError.startsWith(QUOTA_DENIED_PREFIX)) {
    return {
      code: "AI_QUOTA_EXCEEDED",
      message: "Limite de análises do período atingido.",
    };
  }

  const waiting = status === "PENDING" || status === "PROCESSING";

  if (lastError.startsWith(INVALID_RESPONSE_MARKER)) {
    return {
      code: "AI_INVALID_RESPONSE",
      message: waiting
        ? "O modelo respondeu fora do formato esperado; uma nova tentativa está agendada."
        : "O modelo respondeu fora do formato esperado.",
    };
  }

  return {
    code: "AI_ANALYSIS_ERROR",
    message: waiting
      ? "A última tentativa de leitura falhou; uma nova tentativa está agendada."
      : "A leitura automática não pôde ser concluída.",
  };
}

/**
 * Whether the reading waits on the provider rather than on the queue.
 *
 * A request the provider refused carries the pause marker. The ones queued
 * during the outage carry nothing — the circuit keeps them from being
 * claimed at all — so they are paused too while the provider is: said as
 * "Analisando..." and polled every 5 s for hours before.
 */
function isPausedReading(
  status: string,
  error: ProgressError | null,
  providerPaused: boolean,
): boolean {
  if (status !== "PENDING") return false;

  return error?.code === "AI_PROVIDER_PAUSED" || providerPaused;
}

export {
  PAUSED_MESSAGE,
  PROGRESS_ERROR_CODES,
  isPausedReading,
  progressError,
};
export type { ProgressError, ProgressErrorCode };
