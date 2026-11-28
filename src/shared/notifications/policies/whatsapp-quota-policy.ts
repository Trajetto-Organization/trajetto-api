import { NotificationCategory } from "@prisma/client";

import type {
  NotificationPolicyEntry,
  RenderContext,
  WhatsAppQuotaReachedPayload,
} from "../notification-types";

/** "2026-11-19" as the screens write a date: "19/11/2026". */
function brazilianDate(key: string): string {
  const [year, month, day] = key.split("-");

  return `${day}/${month}/${year}`;
}

/**
 * The company's daily WhatsApp quota ran out (plano-escala F3-15b).
 *
 * Told once a day to the admins, who are the ones to ask the support for a
 * larger quota or to look at what is sending so much. The bell only: the
 * notice is about WhatsApp, and an e-mail about it would be the fallback
 * the quota deliberately does not make.
 */
const whatsAppQuotaReachedPolicy: NotificationPolicyEntry<WhatsAppQuotaReachedPayload> =
  {
    // The admin's "Conta" row, as the webhook switched off: the company's
    // account with the platform, not its operation.
    category: NotificationCategory.ACCOUNT,

    // Messages held until tomorrow are not noise a preference should hide.
    mandatory: true,

    // The bell and the phone; no e-mail (see above).
    suppressEmail: true,

    async resolveRecipients(payload, deps) {
      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "whatsapp-quota",
        title: "Cota diária de WhatsApp atingida",
        message:
          `A empresa já enviou hoje as ${payload.limit} mensagens de WhatsApp da cota diária. ` +
          `As próximas ficam guardadas e saem a partir de ${brazilianDate(payload.resumesOn)}, ` +
          `na ordem em que chegaram; nenhuma vai por e-mail no lugar. ` +
          `Para uma cota maior, fale com o suporte.`,
        link: `${ctx.baseUrl}/dashboard`,
        entityId: payload.businessId,
      };
    },
  };

export { whatsAppQuotaReachedPolicy };
