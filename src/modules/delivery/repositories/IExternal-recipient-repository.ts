import type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
} from "../dtos/external-recipient-dto";

import type { ProofDocumentSource } from "@/shared/delivery/proof-document";

interface TrackingSource {
  recipient: ExternalRecipientRecord;

  delivery: {
    id: string;
    code: string | null;
    status: string;

    invoice_number: string | null;

    recipient_name: string;
    city: string;
    uf: string;

    scheduled_date: Date | string | null;
    delivered_at: Date | string | null;
    received_by: string | null;

    business: {
      corporate_reason: string;
      fantasy_name: string | null;
      /** The carrier's zone (decision 1.1), for the times the page prints. */
      timezone?: string | null;
    };
  };

  events: Array<{
    created_at: Date | string;
    type: string;
    note: string | null;
  }>;

  occurrences: Array<{
    created_at: Date | string;
    typeName: string;
    description: string | null;
  }>;

  proofToken: string | null;
}

/**
 * The delivery as it is NOW: its status and the contact it holds. What a
 * customer message is checked against before it is sent, and addressed to.
 */
interface DeliveryContactState {
  status: string;
  name: string;
  email: string | null;
  telephone: string | null;
}

interface IExternalRecipientRepository {
  /**
   * The recipient row for a delivery, created if it is not there yet.
   *
   * Idempotent because the pipeline calls it on every topic: dispatched,
   * delivered, failed. A second row would mean a second token, and the
   * customer's first link would go dark halfway through their delivery.
   */
  ensureForDelivery: (
    data: EnsureExternalRecipientProps,
  ) => Promise<ExternalRecipientRecord>;

  findByToken: (token: string) => Promise<TrackingSource | null>;

  /** They asked to stop hearing from us. Checked before every send. */
  optOut: (token: string) => Promise<boolean>;

  /**
   * The delivery's current status and contact, or null when it no longer
   * exists. One lookup by primary key.
   *
   * The event carries both as they were when it was published; by the time a
   * message goes out — after a backoff, or a re-run of an old event — the
   * delivery may have moved on, or its phone been corrected.
   */
  findDeliveryState: (
    deliveryId: string,
  ) => Promise<DeliveryContactState | null>;
}

export type {
  DeliveryContactState,
  IExternalRecipientRepository,
  TrackingSource,
  ProofDocumentSource,
};
