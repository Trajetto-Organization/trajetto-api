import { NotificationCategory } from "@prisma/client";

import { formatCurrency } from "@/shared/utils/format-values";
import { buildAccountPayableLink } from "@/shared/utils/link-redirect-page";

import {
  AccountPayableUpdatedPayload,
  NotificationPolicyEntry,
  RecipientRenderContext,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
} from "../notification-types";

/**
 * Notification policy for an updated account payable — same hand-over rule
 * as the service order: only a newly assigned responsible is paged.
 */

function renderAccountPayableUpdatedInApp(
  payload: AccountPayableUpdatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  const serviceOrderPart = payload.serviceOrderId
    ? ` | ordem de serviço associada ${payload.serviceOrderId}`
    : "";

  return {
    type: "account-payable",
    title: "Conta a Pagar Atualizada e Atribuída",
    message: `Você foi designado como responsável por uma conta a pagar atualizada${serviceOrderPart}`,
    link: buildAccountPayableLink({
      baseUrl: ctx.baseUrl,
      role: recipient.role,
      driverId: recipient.driverId,
      accountPayableId: payload.accountPayableId,
    }),
    entityId: payload.accountPayableId,
  };
}

function renderAccountPayableUpdatedWhatsApp(
  payload: AccountPayableUpdatedPayload,
): string {
  return [
    `💰 *Conta a Pagar Atualizada! Você foi designado como responsável por uma conta a pagar atualizada*`,
    `Valor: *${formatCurrency(payload.amount)}*`,
    `Identificador da conta a pagar: *${payload.accountPayableId}*`,
    payload.serviceOrderId &&
      `Identificador da ordem de serviço: *${payload.serviceOrderId}*`,
    `Para mais detalhes, acesse o sistema.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderAccountPayableUpdatedActivity(
  payload: AccountPayableUpdatedPayload,
): RenderedActivity {
  return {
    type: "Conta a pagar",
    action: "update",
    entityId: payload.accountPayableId,
    description: `Conta a pagar atualizada com sucesso, no valor de ${formatCurrency(payload.amount)} | ID: ${payload.accountPayableId}`,
    status: "Atualizado",
  };
}

const accountPayableUpdatedPolicy: NotificationPolicyEntry<AccountPayableUpdatedPayload> =
  {
    category: NotificationCategory.FINANCE,

    async resolveRecipients(payload, deps) {
      if (!payload.registrationUserId) return [];

      const responsible = await deps.userRepository.findUserById(
        payload.registrationUserId,
      );

      return responsible ? [responsible] : [];
    },

    renderInApp: renderAccountPayableUpdatedInApp,
    renderWhatsApp: renderAccountPayableUpdatedWhatsApp,
    renderActivity: renderAccountPayableUpdatedActivity,
  };

export {
  accountPayableUpdatedPolicy,
  renderAccountPayableUpdatedInApp,
  renderAccountPayableUpdatedWhatsApp,
  renderAccountPayableUpdatedActivity,
};
