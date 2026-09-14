import { NotificationCategory } from "@prisma/client";

import { formatCurrency, formatDate } from "@/shared/utils/format-values";

import {
  FineCreatedPayload,
  NotificationPolicyEntry,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
} from "../notification-types";

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

function renderFineCreatedWhatsApp(payload: FineCreatedPayload): string {
  // A MASTER registering a fine for a client company is back office — their
  // identity is noise to the admins reading the alert.
  const isMasterActor = payload.actor.role === "MASTER";
  const locationPart = payload.location ? `\nLocal: ${payload.location}` : "";

  return [
    `🚨 *Nova Multa Registrada!*`,
    !isMasterActor && `Usuário: *${payload.actor.name}*`,
    !isMasterActor && `E-mail: *${payload.actor.email}*`,
    `Filial: *${payload.branchName}*`,
    `Veículo: *${payload.vehiclePlate}*`,
    `Valor: *${formatCurrency(payload.amount)}*`,
    `Identificador da multa: *${payload.fineId}*`,
    `Data da infração: *${formatDate(new Date(payload.violationDate), "pt-BR")}*${locationPart}`,
    payload.points && `Pontos na carteira: *${payload.points}`,
    payload.observation && `Observação: *${payload.observation}`,
  ]
    .filter(Boolean)
    .join("\n");
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
