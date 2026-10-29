import type {
  ProofAssessment,
  ProofCriteriaReading,
} from "@/shared/ai/proof-criteria";
import type {
  DeviceAgreement,
  DevicePrecheck,
} from "@/shared/ai-precheck/device-precheck";

type ProofAuditStatus = "PENDING" | "APPROVED" | "REJECTED";

/** AIAnalysisRequest.status of the latest DELIVERY_PROOF request. */
type ProofAnalysisStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED";

/**
 * What the card says about the automatic reading. "No reading" used to cover
 * a company without the AI, a reading still running and one that failed
 * alike, and the reviewer could not tell whether to wait (DLVP-PROOF-4).
 */
type ProofAiState =
  | "read"
  // Decision 14.2: the phone's provisional hint, while the server reads.
  | "device_provisional"
  | "analyzing"
  | "failed"
  | "quota_exceeded"
  | "not_contracted"
  | "unavailable";

/** What the model concluded, stored whole so a later question can be asked. */
interface ProofAuditSuggestion {
  reading: ProofCriteriaReading;
  assessment: ProofAssessment;
}

interface ProofAuditRecord {
  id: string;

  deliveryId: string;
  businessId: string;

  status: ProofAuditStatus;

  ai_suggestion: ProofAuditSuggestion | null;
  ai_confidence: number | null;
  ai_analyzed_at: Date | string | null;

  reviewedById: string | null;
  reviewed_at: Date | string | null;

  rejection_reason: string | null;

  /** The phone's offline check of this photo (decision 14.2); null = none kept. */
  device_precheck: DevicePrecheck | null;

  /** The server's verdict on it, once written; null = not compared yet. */
  device_agreement: DeviceAgreement | null;

  created_at: Date | string;
}

/** One card as the repository reads it. */
interface ProofAuditQueueRow extends ProofAuditRecord {
  delivery: {
    id: string;
    recipient_name: string;
    city: string;
    uf: string;

    invoice_number: string | null;
    code: string | null;

    delivered_at: Date | string | null;
    received_by: string | null;

    driverName: string | null;
  };

  /** Signed, short-lived. The card shows the picture, not a path. */
  photoUrl: string | null;
  signatureUrl: string | null;

  reviewerName: string | null;

  /** The latest reading request for the delivery; null when none exists. */
  analysisStatus: ProofAnalysisStatus | null;
}

/** One card in the queue, with everything it takes to decide without leaving. */
interface ProofAuditCard extends ProofAuditQueueRow {
  aiState: ProofAiState;

  /**
   * The phone's check against the server's reading: the stored verdict, or
   * one computed from the reading on file. Null with nothing to compare.
   */
  deviceAgreement: DeviceAgreement | null;
}

/** What the queue needs to know about the company it belongs to. */
interface ProofAuditQueueSettings {
  /** Business.timezone: the agreement window counts business days. */
  timezone: string | null;

  /** Zero is how a company says it did not buy the reading. */
  ai_analysis_limit: number;
}

interface ListProofAuditsProps {
  businessId: string;
  status: ProofAuditStatus;

  page: number;
  pageSize: number;

  /** Start of the agreement rate's window (see ListProofAuditsResult.meta). */
  agreementSince: Date;
}

interface ProofAuditQueueMeta {
  pending: number;
  approved: number;
  rejected: number;

  /**
   * How often the machine agreed with the person, over the reviewed ones.
   *
   * The only number that answers whether the AI is worth paying for, and it
   * only exists because the suggestion and the verdict are separate columns.
   */
  agreementRate: number | null;
}

interface ListProofAuditsQueue {
  data: ProofAuditQueueRow[];
  total: number;
  meta: ProofAuditQueueMeta;
}

interface ListProofAuditsResult {
  data: ProofAuditCard[];
  total: number;

  meta: ProofAuditQueueMeta & {
    /**
     * The agreement rate covers the decisions of this many business days.
     * Bounded so the number is about the model as it reads today, and so
     * computing it never scans a tenant's whole history (DLVB-04).
     */
    agreementWindowDays: number;
  };
}

export type {
  ListProofAuditsProps,
  ListProofAuditsQueue,
  ListProofAuditsResult,
  ProofAiState,
  ProofAnalysisStatus,
  ProofAuditCard,
  ProofAuditQueueMeta,
  ProofAuditQueueRow,
  ProofAuditQueueSettings,
  ProofAuditRecord,
  ProofAuditStatus,
  ProofAuditSuggestion,
};
