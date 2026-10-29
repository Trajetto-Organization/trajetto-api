import { NotificationCategory } from "@prisma/client";

import {
  NotificationPolicyEntry,
  RenderContext,
  WebhookEndpointDisabledPayload,
} from "../notification-types";

import { REPLAY_WINDOW_DAYS } from "@/shared/integration/webhook-dispatch-rules";

/**
 * A customer's webhook endpoint was switched off by us.
 *
 * Twenty failures in a row, a 410 Gone or a destination refused for good:
 * the breaker used to trip in silence, and the company found out its ERP had
 * stopped receiving events when a reconciliation failed to close, days later.
 * The events are held now, not dropped, so the notice can say what to do:
 * fix the receiver and save the endpoint again, within the replay window.
 */
const webhookEndpointDisabledPolicy: NotificationPolicyEntry<WebhookEndpointDisabledPayload> =
  {
    category: NotificationCategory.SYSTEM,

    // An integration that stopped is not noise a preference should silence:
    // the data it carries is how the customer's own systems stay correct.
    mandatory: true,

    // The admins manage integrations; they are the ones who can act on it.
    async resolveRecipients(payload, deps) {
      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "integration",
        title: `Webhook desligado: ${payload.endpointName}`,
        message:
          `Desligamos o endpoint ${payload.url}. Motivo: ${payload.reason} ` +
          `Os eventos ficam guardados por até ${REPLAY_WINDOW_DAYS} dias e são enviados ` +
          `quando alguém corrigir o receptor e salvar o endpoint de novo.`,
        link: `${ctx.baseUrl}/dashboard/integrations?tab=webhooks`,
        entityId: payload.endpointId,
      };
    },
  };

export { webhookEndpointDisabledPolicy };
