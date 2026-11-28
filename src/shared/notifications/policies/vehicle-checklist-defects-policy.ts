import { NotificationCategory } from "@prisma/client";

import { redirectPage } from "@/shared/utils/link-redirect-page";

import {
  NotificationPolicyEntry,
  RecipientRenderContext,
  RenderContext,
  RenderedInApp,
  VehicleChecklistDefectsFoundPayload,
} from "../notification-types";

/**
 * A vehicle checklist with a defect (plan of 02/11/2026, F2; decision D44).
 *
 * Published only when the inspection found one (shared/vehicle/checklist-
 * defects.ts): a clean checklist stays activity-only, as before, because a
 * daily routine pushed at everybody is noise. The alert goes to the
 * vehicle's responsible person (F1) or, without one — or when that person
 * left the company or lost the access —, to the company's admins. Maintenance: each person's
 * channel choices for that category decide in-app, push and e-mail. No
 * WhatsApp: none of the approved templates (B1) is about it.
 *
 * The link opens the service-order form with the vehicle and the defects
 * filled in (F4, "Abrir OS"), never deciding for the manager: nothing blocks
 * the vehicle by itself.
 */

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");

  return `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`;
}

/** What the suggested service order says, pre-filled in the form (F4). */
function suggestedServiceOrderDescription(
  payload: VehicleChecklistDefectsFoundPayload,
): string {
  const parts = [
    payload.defects.length > 0
      ? `Checklist com defeito: ${payload.defects.join(", ")}.`
      : "Checklist com restrição.",
    payload.verdict ? `Situação: ${payload.verdict}.` : null,
  ];

  return parts.filter(Boolean).join(" ");
}

function serviceOrderLink(
  payload: VehicleChecklistDefectsFoundPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): string {
  const base = redirectPage(recipient.role, recipient.driverId);

  // A driver has no service-order form: their vehicle's orders.
  if (base === "driver") {
    return `${ctx.baseUrl}/driver/vehicles/${payload.vehicleId}/service-orders`;
  }

  const query = new URLSearchParams({
    new: "1",
    vehicleId: payload.vehicleId,
    checklistId: payload.checklistId,
    description: suggestedServiceOrderDescription(payload),
  });

  return `${ctx.baseUrl}/${base}/service-order?${query.toString()}`;
}

function renderVehicleChecklistDefectsInApp(
  payload: VehicleChecklistDefectsFoundPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  const vehicle = `${payload.vehiclePlate} (${payload.vehicleDescription})`;

  const message =
    payload.defects.length > 0
      ? `O checklist do veículo ${vehicle} apontou defeito em ${joinLabels(payload.defects)}.` +
        (payload.verdict ? ` Situação: ${payload.verdict}.` : "")
      : `O checklist do veículo ${vehicle} foi registrado como ${payload.verdict ?? "reprovado"}.`;

  return {
    type: "vehicle-checklist-defect",
    title: `Checklist com defeito: ${payload.vehiclePlate}`,
    message,
    link: serviceOrderLink(payload, ctx, recipient),
    entityId: payload.checklistId,
  };
}

const vehicleChecklistDefectsFoundPolicy: NotificationPolicyEntry<VehicleChecklistDefectsFoundPayload> =
  {
    category: NotificationCategory.MAINTENANCE,

    async resolveRecipients(payload, deps) {
      if (payload.responsibleUserId) {
        const responsible = await deps.userRepository.findUserById(
          payload.responsibleUserId,
        );

        // Still a person of this company, still let in: the alert is theirs
        // alone. Someone offboarded by revoking the access keeps no channel
        // outside the product (the pipeline drops their push and e-mail), so
        // the admins take it, as when nobody is named.
        if (
          responsible &&
          responsible.businessId === payload.businessId &&
          !responsible.access_revoked
        ) {
          return [responsible];
        }
      }

      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    renderInApp: renderVehicleChecklistDefectsInApp,
  };

export {
  renderVehicleChecklistDefectsInApp,
  suggestedServiceOrderDescription,
  vehicleChecklistDefectsFoundPolicy,
};
