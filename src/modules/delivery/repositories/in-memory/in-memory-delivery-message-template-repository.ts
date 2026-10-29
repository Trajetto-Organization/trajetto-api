import { v7 as uuidV7 } from "uuid";

import type {
  DeliveryMessageTemplateRecord,
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
  SaveDeliveryMessageTemplateProps,
} from "../IDelivery-message-template-repository";

/** enum DeliveryMessageTopic, in declaration order. */
const TOPIC_ORDER: readonly DeliveryMessageTopic[] = [
  "DISPATCHED",
  "DELIVERED",
  "FAILED",
  "ON_THE_WAY",
];

/** enum NotificationChannel, in declaration order. */
const CHANNEL_ORDER = [
  "IN_APP",
  "EMAIL",
  "WHATSAPP",
  "ACTIVITY",
  "PUSH",
] as const;

class InMemoryDeliveryMessageTemplateRepository
  implements IDeliveryMessageTemplateRepository
{
  public templates: DeliveryMessageTemplateRecord[] = [];

  async findActive(
    businessId: string,
    topic: DeliveryMessageTopic,
    channel: string,
  ): Promise<DeliveryMessageTemplateRecord | null> {
    return (
      this.templates.find(
        (entry) =>
          entry.businessId === businessId &&
          entry.topic === topic &&
          entry.channel === channel &&
          entry.is_active,
      ) ?? null
    );
  }

  async listByBusiness(
    businessId: string,
  ): Promise<DeliveryMessageTemplateRecord[]> {
    // Prisma orders by topic, then channel, and Postgres sorts enums by
    // declaration order (schema.prisma), not alphabetically.
    const rank = (order: readonly string[], value: string) => {
      const index = order.indexOf(value);

      return index === -1 ? order.length : index;
    };

    return this.templates
      .filter((entry) => entry.businessId === businessId)
      .sort(
        (a, b) =>
          rank(TOPIC_ORDER, a.topic) - rank(TOPIC_ORDER, b.topic) ||
          rank(CHANNEL_ORDER, a.channel) - rank(CHANNEL_ORDER, b.channel),
      );
  }

  async save(
    data: SaveDeliveryMessageTemplateProps,
  ): Promise<DeliveryMessageTemplateRecord> {
    const existing = this.templates.find(
      (entry) =>
        entry.businessId === data.businessId &&
        entry.topic === data.topic &&
        entry.channel === data.channel,
    );

    if (existing) {
      existing.subject = data.subject;
      existing.body = data.body;
      existing.is_active = data.is_active;

      return existing;
    }

    const created: DeliveryMessageTemplateRecord = { id: uuidV7(), ...data };

    this.templates.push(created);

    return created;
  }
}

export { InMemoryDeliveryMessageTemplateRepository };
