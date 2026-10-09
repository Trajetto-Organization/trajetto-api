import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

/**
 * Somebody a notification reaches who has no account.
 *
 * Not a `User` and deliberately not shaped like one: no role, no permissions,
 * no preferences. The whole notion of "their profile" does not exist — they
 * are a phone number and an e-mail on a note, and an id so the delivery ledger
 * has something to point at.
 */
interface ExternalRecipientRecord {
  id: string;

  name: string | null;
  email: string | null;
  telephone: string | null;

  access_token: string;

  expires_at: Date | string | null;
  opted_out_at: Date | string | null;

  deliveryId: string;
  businessId: string;

  created_at: Date | string;
}

interface EnsureExternalRecipientProps {
  deliveryId: string;
  businessId: string;

  name: string | null;
  email: string | null;
  telephone: string | null;
}

/**
 * What the person waiting for the delivery sees on the tracking page.
 *
 * As narrow as the verification page, and for the same reason: the token is
 * the authorisation, so a forwarded link must show one delivery's progress and
 * never become a window on the carrier's operation. No driver name, no phone,
 * no route, no other stop, no shipper.
 */
interface PublicTrackingView {
  recipientName: string;

  /** Street and city only — the person already knows where they live. */
  city: string;
  uf: string;

  status: DeliveryStatus;
  statusLabel: string;

  invoiceNumber: string | null;
  code: string | null;

  scheduledDate: Date | string | null;
  deliveredAt: Date | string | null;
  receivedBy: string | null;

  carrierName: string;

  /**
   * The carrier's zone (IANA), so the page prints its instants on the
   * carrier's clock rather than the server's (decision 1.1). The expected
   * date is a day and needs none.
   */
  timeZone: string;

  /** Newest first, and only the moments a customer can act on. */
  events: Array<{
    at: Date | string;
    title: string;
    detail: string | null;
  }>;

  /** Present once the receipt exists. Points at the public page, not the file. */
  proofUrl: string | null;
}

export type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
  PublicTrackingView,
};
