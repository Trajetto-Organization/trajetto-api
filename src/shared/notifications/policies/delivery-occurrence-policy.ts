import { NotificationCategory } from "@prisma/client";

import {
  DeliveryOccurrenceReportedPayload,
  NotificationPolicyEntry,
  RenderContext,
  RenderedInApp,
} from "../notification-types";

/**
 * A blocking occurrence changed a delivery's fate to Insucesso — the one
 * field event a manager must hear the moment it happens. Recipients are the
 * business admins. Informational occurrences stay in the activity trail
 * (the use case records it) without ringing anyone; that widening belongs
 * to the monitoring panels of the next slice, if the operation asks.
 */

function renderDeliveryOccurrenceInApp(
  payload: DeliveryOccurrenceReportedPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "delivery",
    title: "Entrega com insucesso",
    message:
      `${payload.occurrenceTypeName}: ${payload.reporterName} registrou a ` +
      `ocorrência na entrega para ${payload.recipientName}.`,
    link: `${ctx.baseUrl}/dashboard/deliveries?search=${payload.deliveryId}&page=1`,
    entityId: payload.deliveryId,
  };
}

function renderDeliveryOccurrenceWhatsApp(
  payload: DeliveryOccurrenceReportedPayload,
): string {
  return [
    `🚚 *Entrega com insucesso!*`,
    `Destinatário: *${payload.recipientName}*`,
    `Ocorrência: *${payload.occurrenceTypeName}*`,
    payload.description && `Relato: *${payload.description}*`,
    `Registrada por: *${payload.reporterName}*`,
    payload.photosCount > 0 && `Fotos anexadas: *${payload.photosCount}*`,
    `Status atual: *${payload.deliveryStatusAfter}*`,
  ]
    .filter(Boolean)
    .join("\n");
}

const deliveryOccurrenceReportedPolicy: NotificationPolicyEntry<DeliveryOccurrenceReportedPayload> =
  {
    category: NotificationCategory.TASKS,

    async resolveRecipients(payload, deps) {
      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    // No renderActivity on purpose: the use case already records the trail
    // for every occurrence, blocking or not — a second record here would
    // duplicate it.
    renderInApp: renderDeliveryOccurrenceInApp,
    renderWhatsApp: renderDeliveryOccurrenceWhatsApp,
  };

export {
  deliveryOccurrenceReportedPolicy,
  renderDeliveryOccurrenceInApp,
  renderDeliveryOccurrenceWhatsApp,
};
