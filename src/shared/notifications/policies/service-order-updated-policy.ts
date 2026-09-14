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

function renderServiceOrderUpdatedWhatsApp(
  payload: ServiceOrderUpdatedPayload,
): string {
  return [
    `🔧 *Ordem de Serviço Atualizada! Você foi designado como responsável por uma ordem de serviço atualizada*`,
    `Veículo: *${payload.vehiclePlate || "N/A"}*`,
    `Valor total: *${formatCurrency(payload.totalAmount)}*`,
    `Identificador da OS: *${payload.serviceOrderId}*`,
    `Para mais detalhes, acesse o sistema.`,
  ].join("\n");
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
