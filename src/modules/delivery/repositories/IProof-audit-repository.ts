import type { Prisma } from "@prisma/client";

import type {
  ListProofAuditsProps,
  ListProofAuditsQueue,
  ProofAuditQueueSettings,
  ProofAuditRecord,
} from "../dtos/proof-audit-dto";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";

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
   *
   * `tx` is the proof's own transaction: the card commits with the proof or
   * not at all (INV-08).
   *
   * `devicePrecheck` is the phone's check of THIS photo (decision 14.2): a
   * re-proof replaces it like it replaces the suggestion — null included —
   * and clears the server's verdict on the old one.
   */
  enqueue: (
    deliveryId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
    options?: { devicePrecheck?: DevicePrecheck | null },
  ) => Promise<ProofAuditRecord>;

  findById: (
    auditId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<ProofAuditRecord | null>;

  /**
   * One page of one tab, in the tab's own order, decided in SQL so every
   * page continues the one before it (DLVB-02):
   *
   * - PENDING: the model's review priority (no reading first, then the least
   *   sure), then oldest first, then id.
   * - APPROVED / REJECTED: the decision, newest first (`reviewed_at` desc,
   *   then id desc). History has no priority.
   *
   * The agreement rate is counted in SQL over `agreementSince` onwards
   * (DLVB-04): it used to load every reviewed card of the tenant, JSON
   * included, on every listing.
   */
  listQueue: (props: ListProofAuditsProps) => Promise<ListProofAuditsQueue>;

  /** The company's zone and reading quota; null when it does not exist. */
  findQueueSettings: (
    businessId: string,
  ) => Promise<ProofAuditQueueSettings | null>;

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
  review: (
    props: {
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
