import type {
  ProofAssessment,
  ProofCriteriaReading,
} from "@/shared/ai/proof-criteria";

type ProofAuditStatus = "PENDING" | "APPROVED" | "REJECTED";

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

  created_at: Date | string;
}

/** One card in the queue, with everything it takes to decide without leaving. */
interface ProofAuditCard extends ProofAuditRecord {
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
}

interface ListProofAuditsProps {
  businessId: string;
  status: ProofAuditStatus;

  page: number;
  pageSize: number;
}

interface ListProofAuditsResult {
  data: ProofAuditCard[];
  total: number;

  meta: {
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
  };
}

export type {
  ListProofAuditsProps,
  ListProofAuditsResult,
  ProofAuditCard,
  ProofAuditRecord,
  ProofAuditStatus,
  ProofAuditSuggestion,
};
