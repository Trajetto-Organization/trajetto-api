import { v7 as uuidV7 } from "uuid";
import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type {
  CustomerMessagesReactivation,
  DeliveryContactState,
  IExternalRecipientRepository,
  TrackingSource,
} from "../IExternal-recipient-repository";

import type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
} from "../../dtos/external-recipient-dto";

import {
  messageOptOutOf,
  sharesSuppressionAddress,
  suppressionAddresses,
  uniqueSuppressionAddresses,
  type CustomerContact,
  type CustomerMessageChannel,
  type MessageOptOut,
} from "@/shared/notifications/customer-message-suppression";

/** One customer_message_suppression row (D38). */
interface SuppressionRow {
  businessId: string;
  channel: CustomerMessageChannel;
  address: string;
  source_delivery_id: string | null;
  created_at: Date;
}

class InMemoryExternalRecipientRepository
  implements IExternalRecipientRepository
{
  public recipients: ExternalRecipientRecord[] = [];

  /** Stated by the test, the way the proof repository's sources are. */
  public tracking = new Map<string, TrackingSource>();

  /**
   * The deliveries' current status and contact, by delivery id, stated by the
   * test. An unstated one does not exist, like a deleted delivery.
   */
  public deliveryStates = new Map<string, DeliveryContactState>();

  /**
   * The company of each delivery, by id, stated by the test: what the real
   * reads scope by. A delivery with no company stated is no company's.
   */
  public deliveryCompanies = new Map<string, string>();

  /**
   * The customer_message_suppression table (D38), unique by (businessId,
   * channel, address) as the real index.
   */
  public suppressions: SuppressionRow[] = [];

  async ensureForDelivery(
    data: EnsureExternalRecipientProps,
  ): Promise<ExternalRecipientRecord> {
    const existing = this.recipients.find(
      (entry) => entry.deliveryId === data.deliveryId,
    );

    if (existing) {
      existing.name = data.name;
      existing.email = data.email;
      existing.telephone = data.telephone;

      // The token survives, like the real one: the link already in the
      // customer's hand has to keep working.
      return existing;
    }

    const created: ExternalRecipientRecord = {
      id: uuidV7(),
      name: data.name,
      email: data.email,
      telephone: data.telephone,
      access_token: randomBytes(32).toString("hex"),
      expires_at: null,
      opted_out_at: null,
      deliveryId: data.deliveryId,
      businessId: data.businessId,
      created_at: new Date(),
    };

    this.recipients.push(created);

    return created;
  }

  async findByToken(token: string): Promise<TrackingSource | null> {
    const recipient = this.recipients.find(
      (entry) => entry.access_token === token,
    );

    if (!recipient) return null;

    const source = this.tracking.get(recipient.deliveryId);

    return source ? { ...source, recipient } : null;
  }

  async optOut(token: string): Promise<boolean> {
    const recipient = this.recipients.find(
      (entry) => entry.access_token === token,
    );

    if (!recipient) return false;

    const optedOutNow = recipient.opted_out_at === null;

    if (optedOutNow) recipient.opted_out_at = new Date();

    // Like the real one: the phone and the e-mail for the row's company
    // (the delivery's), on every click, skipping what the unique key
    // already holds.
    for (const { channel, address } of suppressionAddresses(recipient)) {
      const taken = this.suppressions.some(
        (row) =>
          row.businessId === recipient.businessId &&
          row.channel === channel &&
          row.address === address,
      );

      if (!taken) {
        this.suppressions.push({
          businessId: recipient.businessId,
          channel,
          address,
          source_delivery_id: recipient.deliveryId,
          created_at: new Date(),
        });
      }
    }

    return optedOutNow;
  }

  async suppressedChannels(
    businessId: string,
    contact: CustomerContact,
  ): Promise<Set<CustomerMessageChannel>> {
    const wanted = suppressionAddresses(contact);

    return new Set(
      this.suppressions
        .filter(
          (row) =>
            row.businessId === businessId &&
            wanted.some(
              (entry) =>
                entry.channel === row.channel && entry.address === row.address,
            ),
        )
        .map((row) => row.channel),
    );
  }

  async findDeliveryState(
    deliveryId: string,
  ): Promise<DeliveryContactState | null> {
    const state = this.deliveryStates.get(deliveryId);

    if (!state) return null;

    // Like the real one, read off the delivery's recipient row.
    const recipient = this.recipients.find(
      (entry) => entry.deliveryId === deliveryId,
    );

    return {
      ...state,
      optedOut: state.optedOut ?? Boolean(recipient?.opted_out_at),
    };
  }

  /** The delivery's current contact, when it is this company's. */
  private contactOf(
    businessId: string,
    deliveryId: string,
  ): CustomerContact | null {
    const state = this.deliveryStates.get(deliveryId);

    if (!state || this.deliveryCompanies.get(deliveryId) !== businessId) {
      return null;
    }

    return { telephone: state.telephone, email: state.email };
  }

  async messageOptOutState(
    businessId: string,
    deliveryId: string,
  ): Promise<MessageOptOut | null> {
    const contact = this.contactOf(businessId, deliveryId);

    if (!contact) return null;

    const recipient = this.recipients.find(
      (entry) => entry.deliveryId === deliveryId,
    );

    return messageOptOutOf(
      contact,
      this.suppressions.filter((row) => row.businessId === businessId),
      recipient?.opted_out_at ? new Date(recipient.opted_out_at) : null,
    );
  }

  async reactivateCustomerMessages(
    businessId: string,
    deliveryId: string,
    onReactivated?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<CustomerMessagesReactivation | null> {
    const contact = this.contactOf(businessId, deliveryId);

    if (!contact) return null;

    const own = this.recipients.find(
      (entry) =>
        entry.deliveryId === deliveryId && entry.businessId === businessId,
    );

    // Like the real one: the current contact and the recipient row's.
    const addresses = uniqueSuppressionAddresses([
      ...suppressionAddresses(contact),
      ...(own ? suppressionAddresses(own) : []),
    ]);

    const before = this.suppressions.length;

    this.suppressions = this.suppressions.filter(
      (row) =>
        row.businessId !== businessId ||
        !addresses.some(
          (entry) =>
            entry.channel === row.channel && entry.address === row.address,
        ),
    );

    const removedSuppressions = before - this.suppressions.length;

    let clearedOptOuts = 0;

    for (const row of this.recipients) {
      if (row.businessId !== businessId || row.opted_out_at === null) continue;

      if (
        row.deliveryId === deliveryId ||
        sharesSuppressionAddress(row, addresses)
      ) {
        row.opted_out_at = null;
        clearedOptOuts += 1;
      }
    }

    if (removedSuppressions + clearedOptOuts > 0) {
      await onReactivated?.({} as Prisma.TransactionClient);
    }

    return { removedSuppressions, clearedOptOuts };
  }
}

export { InMemoryExternalRecipientRepository };
