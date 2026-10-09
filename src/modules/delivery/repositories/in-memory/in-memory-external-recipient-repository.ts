import { v7 as uuidV7 } from "uuid";
import { randomBytes } from "node:crypto";

import type {
  DeliveryContactState,
  IExternalRecipientRepository,
  TrackingSource,
} from "../IExternal-recipient-repository";

import type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
} from "../../dtos/external-recipient-dto";

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
      (entry) => entry.access_token === token && entry.opted_out_at === null,
    );

    if (!recipient) return false;

    recipient.opted_out_at = new Date();

    return true;
  }

  async findDeliveryState(
    deliveryId: string,
  ): Promise<DeliveryContactState | null> {
    const state = this.deliveryStates.get(deliveryId);

    return state ? { ...state } : null;
  }
}

export { InMemoryExternalRecipientRepository };
