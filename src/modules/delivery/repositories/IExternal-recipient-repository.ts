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

    business: { corporate_reason: string; fantasy_name: string | null };
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
}

export type { IExternalRecipientRepository, TrackingSource, ProofDocumentSource };
