import { v7 as uuidV7 } from "uuid";
import { DELIVERY_PROOF_AUDIT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { IProofAuditRepository } from "../IProof-audit-repository";
import type {
  ListProofAuditsProps,
  ListProofAuditsQueue,
  ProofAnalysisStatus,
  ProofAuditQueueRow,
  ProofAuditQueueSettings,
  ProofAuditRecord,
} from "../../dtos/proof-audit-dto";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";

const time = (value: Date | string): number => new Date(value).getTime();

/** The priority the SQL reads from the JSON: a number, else 0 (no reading). */
function reviewPriority(entry: ProofAuditRecord): number {
  const priority = entry.ai_suggestion?.assessment?.reviewPriority;

  return typeof priority === "number" ? priority : 0;
}

/** Postgres ORDER BY for the queue: priority, created_at, id — all ascending. */
function byQueueOrder(left: ProofAuditRecord, right: ProofAuditRecord): number {
  return (
    reviewPriority(left) - reviewPriority(right) ||
    time(left.created_at) - time(right.created_at) ||
    compareIds(left.id, right.id)
  );
}

/** Postgres ORDER BY reviewed_at DESC (nulls first, its default), id DESC. */
function byDecisionOrder(
  left: ProofAuditRecord,
  right: ProofAuditRecord,
): number {
  if (left.reviewed_at === null && right.reviewed_at !== null) return -1;
  if (right.reviewed_at === null && left.reviewed_at !== null) return 1;

  const byDecision =
    left.reviewed_at !== null && right.reviewed_at !== null
      ? time(right.reviewed_at) - time(left.reviewed_at)
      : 0;

  return byDecision || compareIds(right.id, left.id);
}

// Byte order. The ids are lowercase hex with dashes at fixed positions, so the
// database's collation orders them the same way.
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  public cards = new Map<string, ProofAuditQueueRow["delivery"]>();

  /**
   * The storage paths of each delivery's latest PROOF event, which the real
   * query joins from `delivery_event` and the use case then signs.
   */
  public proofs = new Map<
    string,
    { photo: string | null; signature: string | null }
  >();

  /** `user.name` by id: the reviewer the real query joins (`reviewedBy`). */
  public reviewers = new Map<string, string>();

  /** The `business` rows the queue reads its zone and quota from. */
  public businesses = new Map<string, ProofAuditQueueSettings>();

  /** The `ai_analysis_request` rows of type DELIVERY_PROOF. */
  public analysisRequests: Array<{
    id: string;
    recordId: string;
    businessId: string;
    status: ProofAnalysisStatus;
    created_at: Date;
  }> = [];

  async enqueue(
    deliveryId: string,
    businessId: string,
    _tx?: unknown,
    options?: { devicePrecheck?: DevicePrecheck | null },
  ): Promise<ProofAuditRecord> {
    // A copy, as Postgres stores JSON: the caller's object is not the row.
    const devicePrecheck = options?.devicePrecheck
      ? structuredClone(options.devicePrecheck)
      : null;

    const existing = this.audits.find(
      (entry) => entry.deliveryId === deliveryId,
    );

    if (existing) {
      // The phone's check is about the photo too (decision 14.2).
      existing.device_precheck = devicePrecheck;
      existing.device_agreement = null;

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
      ...DELIVERY_PROOF_AUDIT_COLUMN_DEFAULTS,
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
      device_precheck: devicePrecheck,
      created_at: new Date(),
    };

    this.audits.push(created);

    return created;
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
    agreementSince,
  }: ListProofAuditsProps): Promise<ListProofAuditsQueue> {
    const mine = this.audits.filter((entry) => entry.businessId === businessId);

    const filtered = mine
      .filter((entry) => entry.status === status)
      .sort(status === "PENDING" ? byQueueOrder : byDecisionOrder);

    // Same predicate as the SQL: reviewed, with a suggestion, in the window.
    const reviewed = mine.filter(
      (entry) =>
        entry.status !== "PENDING" &&
        entry.ai_suggestion !== null &&
        entry.reviewed_at !== null &&
        time(entry.reviewed_at) >= agreementSince.getTime(),
    );

    let agreed = 0;

    for (const entry of reviewed) {
      const machineSaidFine =
        entry.ai_suggestion?.assessment?.suggestion === "looks_good";

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
            } as ProofAuditQueueRow["delivery"]),
          // Paths, like the real repository: the use case signs them.
          photoUrl: this.proofs.get(entry.deliveryId)?.photo ?? null,
          signatureUrl: this.proofs.get(entry.deliveryId)?.signature ?? null,
          reviewerName: entry.reviewedById
            ? (this.reviewers.get(entry.reviewedById) ?? null)
            : null,
          analysisStatus: this.latestAnalysisStatus(
            businessId,
            entry.deliveryId,
          ),
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

  private latestAnalysisStatus(
    businessId: string,
    deliveryId: string,
  ): ProofAnalysisStatus | null {
    const latest = this.analysisRequests
      .filter(
        (request) =>
          request.recordId === deliveryId && request.businessId === businessId,
      )
      // created_at DESC, id DESC, like the real query: two requests created
      // in the same instant must resolve to the same one in both.
      .sort(
        (left, right) =>
          time(right.created_at) - time(left.created_at) ||
          compareIds(right.id, left.id),
      )[0];

    return latest?.status ?? null;
  }

  async findQueueSettings(
    businessId: string,
  ): Promise<ProofAuditQueueSettings | null> {
    return this.businesses.get(businessId) ?? null;
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
