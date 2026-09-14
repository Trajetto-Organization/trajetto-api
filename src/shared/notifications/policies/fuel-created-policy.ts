import { NotificationCategory } from "@prisma/client";

import {
  FuelCreatedPayload,
  NotificationPolicyEntry,
  RenderedActivity,
} from "../notification-types";

/**
 * A refuelling only feeds the activity trail — same reasoning as the
 * checklist: a routine per-vehicle event would drown admins if pushed.
 */

function renderFuelCreatedActivity(
  payload: FuelCreatedPayload,
): RenderedActivity {
  // Origin matters in the trail: it tells apart what the driver registered
  // at the pump from what the office typed in later.
  const originPart = payload.origin
    ? ` | Origem: ${payload.origin === "MOBILE_APP" ? "Aplicativo" : "Web"}`
    : "";

  return {
    type: "Abastecimento",
    action: "create",
    entityId: payload.fuelId,
    description: `Abastecimento criado para o veículo ${payload.vehiclePlate} - ${payload.vehicleDescription}${originPart}`,
    status: "Criado",
  };
}

const fuelCreatedPolicy: NotificationPolicyEntry<FuelCreatedPayload> = {
  category: NotificationCategory.SYSTEM,

  async resolveRecipients() {
    return [];
  },

  renderActivity: renderFuelCreatedActivity,
};

export { fuelCreatedPolicy, renderFuelCreatedActivity };
