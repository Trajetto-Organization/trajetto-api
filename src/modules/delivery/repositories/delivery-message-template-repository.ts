import database from "@/../infra/database";

import type {
  DeliveryMessageTemplateRecord,
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
  SaveDeliveryMessageTemplateProps,
} from "./IDelivery-message-template-repository";

import type { NotificationChannel, DeliveryMessageTopic as PrismaTopic } from "@prisma/client";

class DeliveryMessageTemplateRepository
  implements IDeliveryMessageTemplateRepository
{
  constructor(private prisma = database) {}

  async findActive(
    businessId: string,
    topic: DeliveryMessageTopic,
    channel: string,
  ): Promise<DeliveryMessageTemplateRecord | null> {
    const found = await this.prisma.deliveryMessageTemplate.findFirst({
      where: {
        businessId,
        topic: topic as PrismaTopic,
        channel: channel as NotificationChannel,
        is_active: true,
      },
    });

    return found as DeliveryMessageTemplateRecord | null;
  }

  async listByBusiness(
    businessId: string,
  ): Promise<DeliveryMessageTemplateRecord[]> {
    const found = await this.prisma.deliveryMessageTemplate.findMany({
      where: { businessId },
      orderBy: [{ topic: "asc" }, { channel: "asc" }],
    });

    return found as DeliveryMessageTemplateRecord[];
  }

  async save(
    data: SaveDeliveryMessageTemplateProps,
  ): Promise<DeliveryMessageTemplateRecord> {
    const saved = await this.prisma.deliveryMessageTemplate.upsert({
      where: {
        businessId_topic_channel: {
          businessId: data.businessId,
          topic: data.topic as PrismaTopic,
          channel: data.channel as NotificationChannel,
        },
      },
      create: {
        businessId: data.businessId,
        topic: data.topic as PrismaTopic,
        channel: data.channel as NotificationChannel,
        subject: data.subject,
        body: data.body,
        is_active: data.is_active,
      },
      update: {
        subject: data.subject,
        body: data.body,
        is_active: data.is_active,
      },
    });

    return saved as DeliveryMessageTemplateRecord;
  }
}

export { DeliveryMessageTemplateRepository };
