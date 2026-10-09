import type {
  ProofAiState,
  ProofAnalysisStatus,
  ProofAuditStatus,
} from "../../dtos/proof-audit-dto";

/**
 * How long a card with no request may still be waiting for one.
 *
 * The proof asks for the reading right after its commit, and
 * reconcile-proof-analysis-job asks again for two days (its LOOKBACK_MS).
 * Past that nobody will ask any more, so "em andamento" would be a lie.
 */
const ANALYSIS_WAIT_MS = 2 * 24 * 60 * 60 * 1000;

interface ProofAiStateInput {
  hasSuggestion: boolean;
  analysisStatus: ProofAnalysisStatus | null;

  /** Business.ai_analysis_limit > 0. */
  aiContracted: boolean;

  cardStatus: ProofAuditStatus;
  createdAt: Date | string;

  /**
   * The card carries the phone's offline check (decision 14.2). Only kept
   * for a company that bought the reading, so it implies the contract.
   */
  hasDevicePrecheck?: boolean;

  now?: Date;
}

/**
 * What the card says about the automatic reading (DLVP-PROOF-4).
 *
 * "Sem leitura automática" used to cover a company without the AI, a reading
 * still running and one that failed, and the reviewer could not tell whether
 * to wait for a suggestion or judge the photo alone.
 */
function proofAiState({
  hasSuggestion,
  analysisStatus,
  aiContracted,
  cardStatus,
  createdAt,
  hasDevicePrecheck = false,
  now = new Date(),
}: ProofAiStateInput): ProofAiState {
  if (hasSuggestion) return "read";

  const stillWaiting =
    cardStatus === "PENDING" &&
    now.getTime() - new Date(createdAt).getTime() <= ANALYSIS_WAIT_MS;

  switch (analysisStatus) {
    // The phone's hint stands in, as provisional, until the server's reading
    // lands; then the card is "read" like any other (§P5.2).
    case "PENDING":
    case "PROCESSING":
      return hasDevicePrecheck && aiContracted ? "device_provisional" : "analyzing";

    case "FAILED":
    case "PARTIAL":
      return "failed";

    // The request was refused by the period's quota (ai-analysis-service).
    case "SKIPPED":
      return "quota_exceeded";

    // Answered, but not onto this card: a re-proof whose own request has not
    // been opened yet, or a verdict that came before the answer.
    case "COMPLETED":
      return stillWaiting ? "analyzing" : "unavailable";

    default:
      if (!aiContracted) return "not_contracted";

      return stillWaiting ? "analyzing" : "unavailable";
  }
}

export { ANALYSIS_WAIT_MS, proofAiState };
export type { ProofAiStateInput };
