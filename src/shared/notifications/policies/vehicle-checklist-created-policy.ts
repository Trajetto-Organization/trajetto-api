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

/**
 * A driver's arrival checklist made before the route was resolved, from an
 * app build older than the arrival rule (contract < 5): recorded, never
 * refused, and said here so the office sees it. Empty on any other.
 */
function earlyArrivalPart(openStops: number | undefined): string {
  if (openStops === undefined) return "";

  if (openStops === 0) {
    return " | Checklist de chegada feito antes de a rota começar";
  }

  const stops = openStops === 1 ? "1 parada" : `${openStops} paradas`;

  return ` | Checklist de chegada feito com ${stops} em aberto`;
}

function renderVehicleChecklistCreatedActivity(
  payload: VehicleChecklistCreatedPayload,
): RenderedActivity {
  // Origin matters in the trail: it tells apart what the driver registered
  // in the field from what the office typed in later. It stays the last
  // part: the created_from backfill reads descriptions ending in it.
  const originPart = payload.origin
    ? ` | Origem: ${payload.origin === "MOBILE_APP" ? "Aplicativo" : "Web"}`
    : "";

  return {
    type: "Checklist Veicular",
    action: "create",
    entityId: payload.checklistId,
    description: `Checklist veicular criado para o veículo ${payload.vehiclePlate} - ${payload.vehicleDescription}${earlyArrivalPart(payload.arrivalOpenStops)}${originPart}`,
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
