import { NotificationCategory } from "@prisma/client";

import { formatCurrency } from "@/shared/utils/format-values";
import { buildServiceOrderLink } from "@/shared/utils/link-redirect-page";

import {
  NotificationPolicyEntry,
  RecipientRenderContext,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
  ServiceOrderUpdatedPayload,
} from "../notification-types";
import type { RenderedWhatsApp } from "../whatsapp-templates";
import { serviceOrderWhatsApp } from "./service-order-created-policy";

/**
 * Notification policy for an updated service order.
 *
 * Only a hand-over pages someone: the payload carries a responsible id just
 * when this update assigned a new one, so an ordinary edit feeds the activity
 * trail alone.
 */

function renderServiceOrderUpdatedInApp(
  payload: ServiceOrderUpdatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  return {
    type: "service-order",
    title: "Ordem de Serviço Atualizada e Atribuída",
    message: `Você foi designado como responsável por uma ordem de serviço atualizada para o veículo ${payload.vehiclePlate || "N/A"}`,
    link: buildServiceOrderLink({
      baseUrl: ctx.baseUrl,
      role: recipient.role,
      driverId: recipient.driverId,
      vehicleId: payload.vehicleId,
      serviceOrderId: payload.serviceOrderId,
    }),
    entityId: payload.serviceOrderId,
  };
}

/** trajetto_ordem_servico (B1), sent only when the responsible changed. */
function renderServiceOrderUpdatedWhatsApp(
  payload: ServiceOrderUpdatedPayload,
): RenderedWhatsApp {
  return serviceOrderWhatsApp(payload);
}

function renderServiceOrderUpdatedActivity(
  payload: ServiceOrderUpdatedPayload,
): RenderedActivity {
  return {
    type: "Ordem de serviço",
    action: "update",
    entityId: payload.serviceOrderId,
    description: `Ordem de serviço atualizada para o veículo ${payload.vehiclePlate || "N/A"} no valor de ${formatCurrency(payload.totalAmount)} | ID: ${payload.serviceOrderId}`,
    status: "Atualizado",
  };
}

const serviceOrderUpdatedPolicy: NotificationPolicyEntry<ServiceOrderUpdatedPayload> =
  {
    category: NotificationCategory.MAINTENANCE,

    async resolveRecipients(payload, deps) {
      if (!payload.responsibleUserId) return [];

      const responsible = await deps.userRepository.findUserById(
        payload.responsibleUserId,
      );

      return responsible ? [responsible] : [];
    },

    renderInApp: renderServiceOrderUpdatedInApp,
    renderWhatsApp: renderServiceOrderUpdatedWhatsApp,
    renderActivity: renderServiceOrderUpdatedActivity,
  };

export {
  serviceOrderUpdatedPolicy,
  renderServiceOrderUpdatedInApp,
  renderServiceOrderUpdatedWhatsApp,
  renderServiceOrderUpdatedActivity,
};
