import { NotificationCategory } from "@prisma/client";

import {
  AIVerificationIssuePayload,
  NotificationPolicyEntry,
  RenderContext,
  RenderedInApp,
} from "../notification-types";

/**
 * Notification policy for an AI verification that found something actionable
 * — odometer mismatch, fraud signs, contradicted checklist items.
 *
 * Deliberately NOT published for clean or errored runs: a clean result is
 * routine (the record status tells it), and an infrastructure error is an
 * operator concern, not an audit alert. Recipients are the business admins —
 * they audit the fleet; alerting the submitter would tip off exactly the
 * person a fraud check is about.
 */

const STATUS_HEADLINES: Record<string, string> = {
  mismatch: "Divergência de quilometragem detectada",
  fraud: "Suspeita de fraude detectada",
  issues_found: "Checklist com divergências detectadas",
};

function renderAIVerificationIssueInApp(
  payload: AIVerificationIssuePayload,
  ctx: RenderContext,
): RenderedInApp {
  const headline =
    STATUS_HEADLINES[payload.overallStatus] ?? "Divergência detectada";

  const recordLabel =
    payload.recordType === "fuel" ? "abastecimento" : "checklist veicular";

  const vehiclePart = payload.vehiclePlate
    ? ` do veículo ${payload.vehiclePlate}`
    : "";

  const page = payload.recordType === "fuel" ? "fuel" : "vehicle-checklist";

  return {
    type: "ai-verification",
    title: `Verificação IA: ${headline}`,
    message:
      `A verificação IA do ${recordLabel}${vehiclePart} encontrou divergências.` +
      (payload.details ? ` ${payload.details}` : ""),
    link: `${ctx.baseUrl}/dashboard/${page}?search=${payload.recordId}&page=1`,
    entityId: payload.recordId,
  };
}

const aiVerificationIssuePolicy: NotificationPolicyEntry<AIVerificationIssuePayload> =
  {
    category: NotificationCategory.MAINTENANCE,

    async resolveRecipients(payload, deps) {
      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    renderInApp: renderAIVerificationIssueInApp,
  };

export { aiVerificationIssuePolicy, renderAIVerificationIssueInApp };
