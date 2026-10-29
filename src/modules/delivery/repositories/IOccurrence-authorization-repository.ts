import { Prisma } from "@prisma/client";

import type { OccurrenceAuthorizationStatus } from "../dtos/delivery-dto";
import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

/**
 * The tower's side of an occurrence that asks for authorization (decision
 * 6.3): read one to decide it, decide it exactly once, list what waits, and
 * claim what waited too long. Every read is scoped to the company.
 */

interface OccurrenceForDecision {
  id: string;
  businessId: string;
  deliveryId: string;
  occurrenceTypeId: string;
  reportedById: string;

  description: string | null;
  latitude: number | null;
  longitude: number | null;
  photos: string[];

  form_answers: unknown;
  form_version: number | null;

  authorization_status: OccurrenceAuthorizationStatus;
  authorizedById: string | null;
  authorized_at: Date | null;
  authorization_note: string | null;
  escalated_at: Date | null;

  occurred_at: Date | null;
  created_at: Date;

  /** Decision 14.3: a DELIVERED request's approval applies the proof. */
  category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  receipt_photo: string | null;
  signature: string | null;
  received_by: string | null;

  occurrenceType: {
    id: string;
    name: string;
    blocks_delivery: boolean;
    requires_authorization: boolean;
    form_fields: unknown;
  };

  /** `driverId` tells a driver's report (the one the tower answers) apart. */
  reportedBy: { id: string; name: string; driverId: string | null };
  authorizedBy: { id: string; name: string } | null;
}

/** A row of the tower's queue: the request plus the delivery it is about. */
interface PendingAuthorizationRow extends OccurrenceForDecision {
  delivery: {
    id: string;
    code: string | null;
    invoice_number: string | null;
    recipient_name: string;
    street: string;
    address_number: string | null;
    neighborhood: string | null;
    city: string;
    uf: string;
    status: string;
    driver: { id: string; name: string } | null;
  };
}

interface DecideAuthorizationInput {
  occurrenceId: string;
  businessId: string;
  status: "APPROVED" | "DENIED";
  authorizedById: string;
  note: string | null;
  at: Date;
}

/** What an escalation needs to say, read in the transaction that claimed it. */
interface EscalationClaim {
  id: string;
  businessId: string;
  deliveryId: string;
  created_at: Date;
  description: string | null;
  photosCount: number;
  form_answers: unknown;
  occurrenceTypeName: string;
  blocksDelivery: boolean;
  formFields: unknown;
  reporterName: string;
  /** The reporter is a driver (the notice says "o motorista aguarda"). */
  reporterIsDriver: boolean;
  recipientName: string;
  /** Decision 14.3: a delivery request escalates as one. */
  category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
}

interface IOccurrenceAuthorizationRepository {
  /** The occurrence with what a decision reads; null when absent OR another company's. */
  findForDecision: (
    occurrenceId: string,
    businessId: string,
  ) => Promise<OccurrenceForDecision | null>;

  /**
   * PENDING → the decision, conditionally: true when this call decided it,
   * false when it was no longer PENDING (another operator, a proof). The
   * row lock of the UPDATE is what makes two operators produce one decision.
   */
  decide: (
    input: DecideAuthorizationInput,
    tx?: Prisma.TransactionClient,
  ) => Promise<boolean>;

  /**
   * PENDING → SUPERSEDED, conditionally: the attempt the request was about is
   * over (authorization-liveness) before anyone decided. True when this call
   * closed it.
   */
  supersede: (
    occurrenceId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<boolean>;

  /**
   * Locks the delivery a request is about (the row a proof, a cancellation
   * and a status change write) and says, under that lock, whether the
   * request is still live and what the delivery's status is. Null when the
   * occurrence is absent or another company's.
   */
  lockAttempt: (
    occurrenceId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<{ live: boolean; deliveryStatus: DeliveryStatus } | null>;

  /**
   * Locks one delivery for a new request (SELECT … FOR UPDATE): a proof
   * committing meanwhile is either seen here or sees the request.
   */
  lockDeliveryForRequest: (
    deliveryId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<{ status: DeliveryStatus; driverId: string | null } | null>;

  /** PENDING and live: whether a notice about it is still worth sending. */
  isWaiting: (occurrenceId: string, businessId: string) => Promise<boolean>;

  /** The company's live queue, oldest first (the one waiting longest on top). */
  listPending: (
    businessId: string,
    limit: number,
  ) => Promise<{ rows: PendingAuthorizationRow[]; total: number }>;

  /**
   * Closes as SUPERSEDED up to `limit` PENDING requests whose attempt is over,
   * whatever their age, skipping rows another transaction holds. Returns what
   * this call closed.
   */
  supersedeStale: (
    limit: number,
    at: Date,
    tx: Prisma.TransactionClient,
  ) => Promise<Array<{ id: string; businessId: string; deliveryId: string }>>;

  /**
   * Marks as escalated, once, up to `limit` LIVE requests PENDING since
   * before `cutoff` and never escalated — rows another replica is claiming
   * are skipped, not waited on. Returns what this call claimed.
   */
  claimDueEscalations: (
    cutoff: Date,
    limit: number,
    at: Date,
    tx: Prisma.TransactionClient,
  ) => Promise<EscalationClaim[]>;
}

export type {
  DecideAuthorizationInput,
  EscalationClaim,
  IOccurrenceAuthorizationRepository,
  OccurrenceForDecision,
  PendingAuthorizationRow,
};
