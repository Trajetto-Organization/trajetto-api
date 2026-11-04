// ON_THE_WAY: the driver is heading to the address now (decision 6.4).
type DeliveryMessageTopic =
  | "DISPATCHED"
  | "ON_THE_WAY"
  | "DELIVERED"
  | "FAILED";

interface DeliveryMessageTemplateRecord {
  id: string;

  topic: DeliveryMessageTopic;
  channel: string;

  subject: string | null;

  /**
   * Always present on the e-mail (CHECK in the database). Meaningless on
   * WhatsApp, which goes out as a fixed template approved by Meta (plan of
   * 02/11/2026, B3): nullable from migration 20261102120800, written NULL
   * only from the next release, and read as "no text" meanwhile.
   */
  body: string | null;

  is_active: boolean;

  businessId: string;
}

interface SaveDeliveryMessageTemplateProps {
  businessId: string;

  topic: DeliveryMessageTopic;
  channel: string;

  subject: string | null;
  body: string;

  is_active: boolean;
}

interface IDeliveryMessageTemplateRepository {
  /**
   * The company's own words for this moment and channel, or null.
   *
   * Null is a DECISION, not a failure: a carrier that has not written the
   * "saiu para entrega" message does not want one sent. The pipeline reads it
   * that way and creates no delivery row at all.
   */
  findActive: (
    businessId: string,
    topic: DeliveryMessageTopic,
    channel: string,
  ) => Promise<DeliveryMessageTemplateRecord | null>;

  listByBusiness: (
    businessId: string,
  ) => Promise<DeliveryMessageTemplateRecord[]>;

  save: (
    data: SaveDeliveryMessageTemplateProps,
  ) => Promise<DeliveryMessageTemplateRecord>;
}

export type {
  DeliveryMessageTemplateRecord,
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
  SaveDeliveryMessageTemplateProps,
};
