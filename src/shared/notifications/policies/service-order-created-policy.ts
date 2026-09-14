import { NotificationCategory } from "@prisma/client";

import { formatCurrency } from "@/shared/utils/format-values";
import { buildServiceOrderLink } from "@/shared/utils/link-redirect-page";

import {
  NotificationPolicyEntry,
  RecipientRenderContext,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
  ServiceOrderCreatedPayload,
} from "../notification-types";

/**
 * Notification policy for a newly created service order.
 *
 * Unlike a fine, this is not a broadcast: the one person it concerns is the
 * user assigned as responsible, and the link must land on their view of the
 * order — a driver's route is not an admin's route, which is why the render
 * uses the recipient context.
 */

function renderServiceOrderCreatedInApp(
  payload: ServiceOrderCreatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  return {
    type: "service-order",
    title: "Nova Ordem de Serviço",
    message: `Você foi designado como responsável pela ordem de serviço para o veículo ${payload.vehiclePlate || "N/A"}.`,
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

function renderServiceOrderCreatedWhatsApp(
  payload: ServiceOrderCreatedPayload,
): string {
  const mileagePart = payload.newMileage ? ` → ${payload.newMileage}km` : "";

  return [
    `🔧 *Nova Ordem de Serviço! Você foi designado como responsável por uma nova ordem de serviço*`,
    `Veículo: *${payload.vehiclePlate || "N/A"}*`,
    `Valor: *${formatCurrency(payload.totalAmount)}*`,
    payload.currentMileage &&
      `Quilometragem: *${payload.currentMileage}km${mileagePart}*`,
    `Identificador da ordem de serviço: *${payload.serviceOrderId}*`,
    `Para mais detalhes, acesse o sistema.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderServiceOrderCreatedActivity(
  payload: ServiceOrderCreatedPayload,
): RenderedActivity {
  const mileagePart = payload.newMileage ? ` → ${payload.newMileage}km` : "";

  return {
    type: "Ordem de serviço",
    action: "create",
    entityId: payload.serviceOrderId,
    description:
      `Ordem de serviço criada para o veículo ${payload.vehiclePlate || "N/A"} ` +
      `no valor de ${formatCurrency(payload.totalAmount)} | ` +
      `Quilometragem: ${payload.currentMileage}km${mileagePart} | ` +
      `ID: ${payload.serviceOrderId}`,
    status: payload.isCompleted ? "Completo" : "Pendente",
  };
}

const serviceOrderCreatedPolicy: NotificationPolicyEntry<ServiceOrderCreatedPayload> =
  {
    category: NotificationCategory.MAINTENANCE,

    async resolveRecipients(payload, deps) {
      const responsible = await deps.userRepository.findUserById(
        payload.responsibleUserId,
      );

      return responsible ? [responsible] : [];
    },

    renderInApp: renderServiceOrderCreatedInApp,
    renderWhatsApp: renderServiceOrderCreatedWhatsApp,
    renderActivity: renderServiceOrderCreatedActivity,
  };

export {
  serviceOrderCreatedPolicy,
  renderServiceOrderCreatedInApp,
  renderServiceOrderCreatedWhatsApp,
  renderServiceOrderCreatedActivity,
};
