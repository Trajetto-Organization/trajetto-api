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
import type { RenderedWhatsApp } from "../whatsapp-templates";
import {
  accountPayableCategoryLabel,
  dayLabel,
  oneLine,
  shortId,
} from "../whatsapp-parameters";

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

/** trajetto_conta_pagar (B1): the same template for created and updated. */
function renderAccountPayableCreatedWhatsApp(
  payload: AccountPayableCreatedPayload,
): RenderedWhatsApp {
  return accountPayableWhatsApp(payload);
}

/**
 * Shared with account-payable.updated: "foi atribuída a você como
 * responsável" is true of both. The amount opens the text because it is
 * what the notification preview shows.
 */
function accountPayableWhatsApp(
  payload: Pick<
    AccountPayableCreatedPayload,
    | "amount"
    | "serviceOrderId"
    | "payeeName"
    | "dueDate"
    | "timeZone"
    | "category"
    | "categoryDescription"
    | "description"
    | "serviceOrderVehiclePlate"
  >,
): RenderedWhatsApp {
  const linkedOrder = payload.serviceOrderId
    ? oneLine(payload.serviceOrderVehiclePlate)
      ? `${shortId(payload.serviceOrderId)} (veículo ${oneLine(payload.serviceOrderVehiclePlate)})`
      : shortId(payload.serviceOrderId)
    : null;

  return {
    template: "trajetto_conta_pagar",
    parameters: [
      formatCurrency(Number(payload.amount) || 0),
      oneLine(payload.payeeName),
      dayLabel(payload.dueDate, payload.timeZone),
      accountPayableCategoryLabel(
        payload.category,
        payload.categoryDescription,
      ),
      oneLine(payload.description),
      linkedOrder,
    ],
  };
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
  accountPayableWhatsApp,
};
