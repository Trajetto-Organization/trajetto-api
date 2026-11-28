import type { Prisma } from "@prisma/client";

import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";
import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";
import { deliveryEventPayload } from "@/shared/integration/announce";
import type { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

/**
 * What a load that joins a RUNNING route says, in the commit that put it on
 * the street (K12, decision D30): the repository's addStops already moved
 * it to IN_TRANSIT with the line "Saiu para entrega (Rota N)", as the
 * departure moves its own load, and this tells the two audiences the
 * departure tells — the customers' systems (`delivery.in_transit`, F2-06)
 * and whoever waits for it ("saiu para entrega", `delivery.dispatched`).
 *
 * One place for add-stops and move-stops. move-stops lands deliveries on
 * the same running routes (the Entregas "Adicionar à rota" calls it as soon
 * as one of them comes from another route) and said neither: the load went
 * "Em rota" in silence for the ERP and the recipient (audit of 25/11/2026).
 *
 * Inside the caller's transaction, like the departure's: an event queued
 * after the commit is one a crash in between erases.
 */
async function announceDepartedStops(
  tx: Prisma.TransactionClient,
  {
    webhooks,
    outbox,
  }: { webhooks: WebhookFanOutService; outbox?: OutboxService },
  {
    businessId,
    actorId,
    deliveries,
  }: { businessId: string; actorId: string; deliveries: Delivery[] },
): Promise<void> {
  await webhooks.announceMany(
    "delivery.in_transit",
    businessId,
    deliveries.map((delivery) =>
      deliveryEventPayload({
        ...delivery,
        id: delivery.id!,
        businessId,
        status: "IN_TRANSIT",
      }),
    ),
    tx,
  );

  for (const delivery of deliveries) {
    if (!hasSomebodyToTell(delivery)) continue;

    await outbox?.publish(tx, {
      topic: "delivery.dispatched",
      aggregateType: "delivery",
      aggregateId: delivery.id!,
      businessId,
      actorId,
      payload: buildDeliveryCustomerPayload(delivery.id!, {
        ...delivery,
        businessId,
      }),
    });
  }
}

export { announceDepartedStops };
