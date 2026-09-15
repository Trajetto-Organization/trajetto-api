import type { Prisma } from "@prisma/client";

import type {
  ListProofAuditsProps,
  ListProofAuditsResult,
  ProofAuditRecord,
  ProofAuditSuggestion,
} from "../dtos/proof-audit-dto";

/**
 * The queue a receipt waits in for a person to look at it.
 *
 * Every method takes the `businessId` alongside the id and puts it in the
 * `where`, for the same reason the route module does: the use case protects
 * the path somebody remembered, and the `where` protects the ones nobody
 * thought about.
 */
interface IProofAuditRepository {
  /**
   * Opens the card, or reopens it when a delivery is proven again.
   *
   * Idempotent: the proof use case calls it on every proof, and a driver's
   * outbox resends after a dead network. A second row would be a second card
   * for the same address.
   */
  enqueue: (deliveryId: string, businessId: string) => Promise<ProofAuditRecord>;

  /** Attaches what the model concluded, once it answers. */
  attachSuggestion: (
    deliveryId: string,
    businessId: string,
    suggestion: ProofAuditSuggestion,
    confidence: number,
  ) => Promise<void>;

  findById: (
    auditId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<ProofAuditRecord | null>;

  listQueue: (props: ListProofAuditsProps) => Promise<ListProofAuditsResult>;

  /**
   * Records a person's decision, and only if nobody got there first.
   *
   * A write precondition rather than a read-then-write: two reviewers open the
   * same card, both press approve, and the second must be told the card has
   * already been decided rather than silently overwriting the first name on
   * the record of who decided it.
   *
   * Returns null when the precondition did not hold.
   */
  review: (props: {
    auditId: string;
    businessId: string;
    reviewedById: string;
    status: "APPROVED" | "REJECTED";
    rejection_reason: string | null;
  },
    tx?: Prisma.TransactionClient,
  ) => Promise<ProofAuditRecord | null>;
}

export type { IProofAuditRepository };
