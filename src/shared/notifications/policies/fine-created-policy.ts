import { NotificationCategory } from "@prisma/client";

import { formatCurrency } from "@/shared/utils/format-values";

import {
  FineCreatedPayload,
  NotificationPolicyEntry,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
} from "../notification-types";
import type { RenderedWhatsApp } from "../whatsapp-templates";
import { actorLabel, dayLabel, oneLine } from "../whatsapp-parameters";

/**
 * Notification policy for a newly registered fine.
 *
 * Recipients are the business admins of the fine's company — for a MASTER
 * actor that is the target company's admins, for business actors it is their
 * own company (the tenant guard already forces both to coincide).
 */

function renderFineCreatedInApp(
  payload: FineCreatedPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "fine",
    title: "Nova Multa Registrada",
    message: `Nova multa de ${formatCurrency(payload.amount)} foi registrada para o veículo ${payload.vehiclePlate}`,
    link: `${ctx.baseUrl}/dashboard/fine?search=${payload.fineId}&page=1`,
    entityId: payload.fineId,
  };
}

/**
 * trajetto_multa_registrada (B1). A MASTER registering a fine for a client
 * company is back office: the admins read "Suporte Trajetto", never the
 * master's name or e-mail.
 */
function renderFineCreatedWhatsApp(
  payload: FineCreatedPayload,
): RenderedWhatsApp {
  const violation = oneLine(payload.violationDescription)
    ? `${payload.violationCode} – ${oneLine(payload.violationDescription)}`
    : payload.violationCode;

  return {
    template: "trajetto_multa_registrada",
    parameters: [
      payload.vehiclePlate,
      payload.driverName,
      payload.branchName,
      violation,
      dayLabel(payload.violationDate, payload.timeZone),
      oneLine(payload.location),
      // Zero points is a value worth printing; only absence is not.
      payload.points === null || payload.points === undefined
        ? null
        : String(payload.points),
      formatCurrency(Number(payload.amount) || 0),
      dayLabel(payload.dueDate, payload.timeZone),
      oneLine(payload.observation),
      actorLabel(payload.actor, { maskMaster: true }),
    ],
  };
}

function renderFineCreatedActivity(
  payload: FineCreatedPayload,
): RenderedActivity {
  return {
    type: "Multa",
    action: "create",
    entityId: payload.fineId,
    description:
      `Multa registrada para o motorista ${payload.driverName} ` +
      `no valor de ${formatCurrency(payload.amount)} | ` +
      `Infração: ${payload.violationCode} | ` +
      `Veículo: ${payload.vehiclePlate} | ` +
      `Pontos: ${payload.points} | ` +
      `ID: ${payload.fineId}`,
    status: "Pendente",
  };
}

const fineCreatedPolicy: NotificationPolicyEntry<FineCreatedPayload> = {
  category: NotificationCategory.FINES,

  async resolveRecipients(payload, deps) {
    return deps.userRepository.findBusinessAdminsByBusinessId(
      payload.businessId,
    );
  },

  renderInApp: renderFineCreatedInApp,
  renderWhatsApp: renderFineCreatedWhatsApp,
  renderActivity: renderFineCreatedActivity,
};

export {
  fineCreatedPolicy,
  renderFineCreatedInApp,
  renderFineCreatedWhatsApp,
  renderFineCreatedActivity,
};
