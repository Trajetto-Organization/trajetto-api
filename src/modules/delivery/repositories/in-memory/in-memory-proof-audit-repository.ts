import { v7 as uuidV7 } from "uuid";

import type { IProofAuditRepository } from "../IProof-audit-repository";
import type {
  ListProofAuditsProps,
  ListProofAuditsResult,
  ProofAuditCard,
  ProofAuditRecord,
  ProofAuditSuggestion,
} from "../../dtos/proof-audit-dto";

/**
 * The queue, mirrored — including the two preconditions that live in the real
 * repository's `where` and nowhere else.
 *
 * A fake that let a second reviewer overwrite the first, or that let a late AI
 * answer drag a decided card back to PENDING, would accept writes Postgres
 * refuses and let a test prove the opposite of the truth.
 */
class InMemoryProofAuditRepository implements IProofAuditRepository {
  public audits: ProofAuditRecord[] = [];

  /** Stated by the test; the real one joins four tables to build a card. */
  public cards = new Map<string, ProofAuditCard["delivery"]>();

  async enqueue(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofAuditRecord> {
    const existing = this.audits.find(
      (entry) => entry.deliveryId === deliveryId,
    );

    if (existing) {
      // A re-proof is a new photo: the old verdict and the old suggestion are
      // about a picture that is no longer on file.
      existing.status = "PENDING";

      existing.ai_suggestion = null;
      existing.ai_confidence = null;
      existing.ai_analyzed_at = null;

      existing.reviewedById = null;
      existing.reviewed_at = null;
      existing.rejection_reason = null;

      return existing;
    }

    const created: ProofAuditRecord = {
      id: uuidV7(),
      deliveryId,
      businessId,
      status: "PENDING",
      ai_suggestion: null,
      ai_confidence: null,
      ai_analyzed_at: null,
      reviewedById: null,
      reviewed_at: null,
      rejection_reason: null,
      created_at: new Date(),
    };

    this.audits.push(created);

    return created;
  }

  async attachSuggestion(
    deliveryId: string,
    businessId: string,
    suggestion: ProofAuditSuggestion,
    confidence: number,
  ): Promise<void> {
    const found = this.audits.find(
      (entry) =>
        entry.deliveryId === deliveryId &&
        entry.businessId === businessId &&
        entry.status === "PENDING",
    );

    if (!found) return;

    found.ai_suggestion = suggestion;
    found.ai_confidence = confidence;
    found.ai_analyzed_at = new Date();
  }

  async findById(
    auditId: string,
    businessId: string,
  ): Promise<ProofAuditRecord | null> {
    return (
      this.audits.find(
        (entry) => entry.id === auditId && entry.businessId === businessId,
      ) ?? null
    );
  }

  async listQueue({
    businessId,
    status,
    page,
    pageSize,
  }: ListProofAuditsProps): Promise<ListProofAuditsResult> {
    const mine = this.audits.filter((entry) => entry.businessId === businessId);

    const filtered = mine
      .filter((entry) => entry.status === status)
      .sort(
        (left, right) =>
          new Date(left.created_at).getTime() -
          new Date(right.created_at).getTime(),
      );

    const reviewed = mine.filter(
      (entry) => entry.status !== "PENDING" && entry.ai_suggestion !== null,
    );

    let agreed = 0;

    for (const entry of reviewed) {
      const machineSaidFine =
        entry.ai_suggestion?.assessment.suggestion === "looks_good";

      if (machineSaidFine === (entry.status === "APPROVED")) agreed += 1;
    }

    return {
      data: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map((entry) => ({
          ...entry,
          delivery:
            this.cards.get(entry.deliveryId) ??
            ({
              id: entry.deliveryId,
              recipient_name: "Destinatário",
              city: "São Paulo",
              uf: "SP",
              invoice_number: null,
              code: null,
              delivered_at: null,
              received_by: null,
              driverName: null,
            } as ProofAuditCard["delivery"]),
          photoUrl: null,
          signatureUrl: null,
          reviewerName: null,
        })),

      total: filtered.length,

      meta: {
        pending: mine.filter((entry) => entry.status === "PENDING").length,
        approved: mine.filter((entry) => entry.status === "APPROVED").length,
        rejected: mine.filter((entry) => entry.status === "REJECTED").length,
        agreementRate: reviewed.length > 0 ? agreed / reviewed.length : null,
      },
    };
  }

  async review({
    auditId,
    businessId,
    reviewedById,
    status,
    rejection_reason,
  }: {
    auditId: string;
    businessId: string;
    reviewedById: string;
    status: "APPROVED" | "REJECTED";
    rejection_reason: string | null;
  }): Promise<ProofAuditRecord | null> {
    const found = this.audits.find(
      (entry) =>
        entry.id === auditId &&
        entry.businessId === businessId &&
        // The precondition, exactly as the real `where` states it.
        entry.status === "PENDING",
    );

    if (!found) return null;

    found.status = status;
    found.reviewedById = reviewedById;

    found.reviewed_at = new Date();
    found.rejection_reason = rejection_reason;

    return found;
  }
}

export { InMemoryProofAuditRepository };
