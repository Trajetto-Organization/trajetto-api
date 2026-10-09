import {
  PROOF_INPUT_VERSION,
  type DeliveryProofAnalysisInput,
} from "@/shared/ai/ai-types";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";

interface ProofAnalysisSource {
  photoPath: string;
  signaturePath: string | null;

  delivery: {
    invoice_number?: string | null;
    code?: string | null;
    recipient_name: string;
  };

  /** When the receipt was signed (the event's occurred_at, else its creation). */
  provenAt: Date;

  /**
   * The company's zone (Business.timezone). The day compared with the date
   * written on the slip is the carrier's business day: in UTC, a receipt
   * signed at 22:00 in São Paulo read as the next day (DLVP-PROOF-4). Absent
   * or unknown falls back to the default zone.
   */
  timeZone?: string | null;
}

/**
 * What a receipt's reading is compared with.
 *
 * One builder for the two callers — the proof itself, right after its commit,
 * and the sweep that asks again for a card whose request was lost
 * (reconcile-proof-analysis-job). The request's idempotency key is a hash of
 * this input, so the two must build it identically: a sweep that spelled one
 * field differently would open a second, billed request for a proof whose
 * first one is still running.
 *
 * The expected values travel WITH the request rather than being looked up at
 * analysis time, because the analysis runs minutes later and the delivery may
 * have been corrected in between — the reading has to be compared with the
 * document that was proven, not with the row as it stands now. They are never
 * put in the prompt (decision 6.9): the code compares.
 *
 * The expected document is the NF-e number only. The delivery's own code is
 * not printed on a DANFE's receipt, and comparing the digits read off the
 * slip with it would call every receipt of a delivery without an invoice
 * "wrong number".
 */
function buildProofAnalysisInput({
  photoPath,
  signaturePath,
  delivery,
  provenAt,
  timeZone,
}: ProofAnalysisSource): DeliveryProofAnalysisInput {
  return {
    photoPath,
    signaturePath,
    expectedDocument: delivery.invoice_number?.trim() || null,
    expectedRecipient: delivery.recipient_name,
    provenOn: businessDateKey(provenAt, resolveTimeZone(timeZone)),
    inputVersion: PROOF_INPUT_VERSION,
  };
}

export { buildProofAnalysisInput };
export type { ProofAnalysisSource };
