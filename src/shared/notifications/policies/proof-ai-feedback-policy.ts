import { NotificationCategory } from "@prisma/client";

import {
  DeliveryProofAIFlaggedPayload,
  NotificationPolicyEntry,
  RenderContext,
  RenderedInApp,
  RenderedPush,
} from "../notification-types";

/**
 * The driver hears that the receipt they sent looks wrong (decision 6.9).
 *
 * The reading is a suggestion — the office decides, and the text says so —
 * but it is worth the driver's attention while they may still be near the
 * address: a photo of the wrong paper, without a signature or of another
 * delivery's receipt is cheapest to fix before the truck leaves the street.
 *
 * Push and in-app: the push reaches a phone in a pocket; the notification
 * row stays in the app's feed for a driver who was driving when it rang
 * (docs/contratos-app/ai-feedback.md). No e-mail: this is about the next
 * minutes, not the inbox. Mandatory, like the route notices: preferences
 * control noise, and this is the operation asking the driver to look.
 */

const TITLE = "Comprovante com possível problema";

/**
 * The problems arrive already said as problems, in lower case, from
 * describeProblems (proof-criteria.ts): "a foto não parece um canhoto de
 * entrega", never the card's positive question "É um canhoto de entrega",
 * which told the driver the opposite of what was wrong.
 */
function problemSentence(payload: DeliveryProofAIFlaggedPayload): string {
  if (payload.problems.length === 0) return payload.summary;

  return `A leitura automática apontou: ${payload.problems.join("; ")}.`;
}

function feedbackMessage(payload: DeliveryProofAIFlaggedPayload): string {
  return (
    `Entrega para ${payload.recipientName}. ${problemSentence(payload)} ` +
    "Se ainda estiver no local, confira o canhoto com o destinatário. " +
    "A equipe vai revisar o comprovante."
  );
}

function renderProofFeedbackPush(
  payload: DeliveryProofAIFlaggedPayload,
): RenderedPush {
  return {
    title: TITLE,
    body: feedbackMessage(payload),

    // The app opens the delivery the push is about. Its id rides as
    // `entityId`, the same key as the inbox row: the notification pipeline
    // stamps its own `deliveryId` (the notification delivery's id) on every
    // push and overwrote the delivery's id sent under that name.
    data: {
      url: "/deliveries",
      type: "delivery-proof.ai-flagged",
      entityId: payload.deliveryId,
    },
  };
}

function renderProofFeedbackInApp(
  payload: DeliveryProofAIFlaggedPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "delivery-proof-ai",
    title: TITLE,
    message: feedbackMessage(payload),
    // The driver's deliveries live in the app, not on the web; the web's
    // own inbox is the page a driver can open there.
    link: `${ctx.baseUrl}/notifications`,
    entityId: payload.deliveryId,
  };
}

const proofAIFeedbackPolicy: NotificationPolicyEntry<DeliveryProofAIFlaggedPayload> =
  {
    category: NotificationCategory.TASKS,
    mandatory: true,
    suppressEmail: true,

    async resolveRecipients(payload, deps) {
      const driver = await deps.userRepository.findUserById(
        payload.driverUserId,
      );

      // Only the person who proved it, and only inside the company the
      // delivery belongs to: a user moved to another company since then is
      // no longer the one to tell.
      return driver && driver.businessId === payload.businessId ? [driver] : [];
    },

    renderInApp: renderProofFeedbackInApp,
    renderPush: renderProofFeedbackPush,
  };

export {
  feedbackMessage,
  proofAIFeedbackPolicy,
  renderProofFeedbackInApp,
  renderProofFeedbackPush,
};
