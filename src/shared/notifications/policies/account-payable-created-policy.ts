import { NotificationCategory } from "@prisma/client";

import { formatCurrency } from "@/shared/utils/format-values";
import { buildAccountPayableLink } from "@/shared/utils/link-redirect-page";

import {
  AccountPayableCreatedPayload,
  NotificationPolicyEntry,
  RecipientRenderContext,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
} from "../notification-types";

/**
 * Notification policy for a newly registered account payable.
 *
 * Single recipient — the user registered as responsible for the bill — with a
 * role-dependent link, same shape as the service-order policy.
 */

function renderAccountPayableCreatedInApp(
  payload: AccountPayableCreatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  const serviceOrderPart = payload.serviceOrderId
    ? ` | ordem de serviço associada ${payload.serviceOrderId}`
    : "";

  return {
    type: "account-payable",
    title: "Nova Conta a Pagar",
    message: `Você foi designado como responsável por uma nova conta a pagar${serviceOrderPart}`,
    link: buildAccountPayableLink({
      baseUrl: ctx.baseUrl,
      role: recipient.role,
      driverId: recipient.driverId,
      accountPayableId: payload.accountPayableId,
    }),
    entityId: payload.accountPayableId,
  };
}

function renderAccountPayableCreatedWhatsApp(
  payload: AccountPayableCreatedPayload,
): string {
  return [
    `💰 *Nova Conta a Pagar! Você foi designado como responsável por uma nova conta a pagar*`,
    `Valor: *${formatCurrency(payload.amount)}*`,
    `Identificador da conta a pagar: *${payload.accountPayableId}*`,
    payload.serviceOrderId &&
      `Identificador da ordem de serviço: *${payload.serviceOrderId}*`,
    `Para mais detalhes, acesse o sistema.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderAccountPayableCreatedActivity(
  payload: AccountPayableCreatedPayload,
): RenderedActivity {
  return {
    type: "Conta a pagar",
    action: "create",
    entityId: payload.accountPayableId,
    description: `Conta a pagar criada com sucesso, no valor de ${formatCurrency(payload.amount)} | ID: ${payload.accountPayableId}`,
    status: "Completo",
  };
}

const accountPayableCreatedPolicy: NotificationPolicyEntry<AccountPayableCreatedPayload> =
  {
    category: NotificationCategory.FINANCE,

    async resolveRecipients(payload, deps) {
      const responsible = await deps.userRepository.findUserById(
        payload.registrationUserId,
      );

      return responsible ? [responsible] : [];
    },

    renderInApp: renderAccountPayableCreatedInApp,
    renderWhatsApp: renderAccountPayableCreatedWhatsApp,
    renderActivity: renderAccountPayableCreatedActivity,
  };

export {
  accountPayableCreatedPolicy,
  renderAccountPayableCreatedInApp,
  renderAccountPayableCreatedWhatsApp,
  renderAccountPayableCreatedActivity,
};
