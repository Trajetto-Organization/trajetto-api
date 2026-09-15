import { v7 as uuidV7 } from "uuid";

import type {
  DeliveryMessageTemplateRecord,
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
  SaveDeliveryMessageTemplateProps,
} from "../IDelivery-message-template-repository";

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
    return this.templates.filter((entry) => entry.businessId === businessId);
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
