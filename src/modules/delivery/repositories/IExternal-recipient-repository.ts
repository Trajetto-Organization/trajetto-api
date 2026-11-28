import type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
} from "../dtos/external-recipient-dto";

import type { ProofDocumentSource } from "@/shared/delivery/proof-document";
import type { Prisma } from "@prisma/client";

import type {
  CustomerContact,
  CustomerMessageChannel,
  MessageOptOut,
} from "@/shared/notifications/customer-message-suppression";

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

  /**
   * The other deliveries of the same visit — the stop's siblings on the
   * delivery's current route (RouteStop.stop_group_key; plan of 02/11/2026,
   * B6): one message per stop carries one link, and its page lists the rest.
   * Same address and same recipient by construction. Optional: absent reads
   * as none.
   */
  sameStop?: Array<{
    code: string | null;
    invoice_number: string | null;
    status: string;
    delivered_at: Date | string | null;
  }>;
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

  /**
   * The person asked to stop hearing about THIS delivery (its recipient
   * row's opted_out_at). One message per stop (B6) honours a stop asked of
   * any delivery of the stop. Optional: absent reads as not opted out.
   */
  optedOut?: boolean;
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

  /**
   * They asked to stop hearing from us. Checked before every send.
   *
   * Marks this delivery's recipient row and, in the same transaction, keeps
   * the row's phone and e-mail as suppressed for the delivery's company
   * (D38): every later customer message of that company to them is dropped.
   * Idempotent (upsert by the unique key, safe across replicas); true only
   * when this call opted the row out. A token nobody holds changes nothing.
   */
  optOut: (token: string) => Promise<boolean>;

  /**
   * The channels whose address this company's customers asked to stop
   * (D38), for a message about to be expanded or sent to this contact. One
   * lookup by the unique key; never another company's rows.
   */
  suppressedChannels: (
    businessId: string,
    contact: CustomerContact,
  ) => Promise<Set<CustomerMessageChannel>>;

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

  /**
   * When the delivery's current phone and e-mail stopped receiving this
   * company's customer messages (contract C2; messageOptOutOf), or null
   * when the delivery is not this company's. Reads only this company's
   * suppressions.
   */
  messageOptOutState: (
    businessId: string,
    deliveryId: string,
  ) => Promise<MessageOptOut | null>;

  /**
   * Undoes the opt-out of the delivery's recipient inside this company
   * (contract C2), in one transaction: deletes the company's suppressions
   * of the recipient's normalized phone and e-mail (the delivery's current
   * contact and its recipient row's, which may predate a correction) and
   * clears opted_out_at of every recipient row of the company with the same
   * normalized contact, this delivery's included. `onReactivated` runs in
   * that transaction only when something changed (the activity line).
   * Null when the delivery is not this company's; a second call changes
   * nothing and answers zeros.
   */
  reactivateCustomerMessages: (
    businessId: string,
    deliveryId: string,
    onReactivated?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<CustomerMessagesReactivation | null>;
}

interface CustomerMessagesReactivation {
  removedSuppressions: number;
  clearedOptOuts: number;
}

export type {
  CustomerMessagesReactivation,
  DeliveryContactState,
  IExternalRecipientRepository,
  TrackingSource,
  ProofDocumentSource,
};
