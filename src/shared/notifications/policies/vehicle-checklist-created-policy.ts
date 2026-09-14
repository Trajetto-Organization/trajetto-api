import { NotificationCategory } from "@prisma/client";

import {
  NotificationPolicyEntry,
  RenderedActivity,
  VehicleChecklistCreatedPayload,
} from "../notification-types";

/**
 * A new checklist only feeds the activity trail — inspections happen daily
 * per vehicle, so pushing each one at every admin would be pure noise. The
 * driver-facing confirmations live in the app itself.
 */

function renderVehicleChecklistCreatedActivity(
  payload: VehicleChecklistCreatedPayload,
): RenderedActivity {
  // Origin matters in the trail: it tells apart what the driver registered
  // in the field from what the office typed in later.
  const originPart = payload.origin
    ? ` | Origem: ${payload.origin === "MOBILE_APP" ? "Aplicativo" : "Web"}`
    : "";

  return {
    type: "Checklist Veicular",
    action: "create",
    entityId: payload.checklistId,
    description: `Checklist veicular criado para o veículo ${payload.vehiclePlate} - ${payload.vehicleDescription}${originPart}`,
    status: "Criado",
  };
}

const vehicleChecklistCreatedPolicy: NotificationPolicyEntry<VehicleChecklistCreatedPayload> =
  {
    category: NotificationCategory.SYSTEM,

    async resolveRecipients() {
      return [];
    },

    renderActivity: renderVehicleChecklistCreatedActivity,
  };

export { vehicleChecklistCreatedPolicy, renderVehicleChecklistCreatedActivity };
