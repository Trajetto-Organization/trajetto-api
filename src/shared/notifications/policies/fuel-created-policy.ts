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

/**
 * Another refuelling of the vehicle within 30 minutes (RECENT_REFUEL,
 * 05/11/2026): said here so the office sees it, with the driver's reason
 * when they confirmed. Empty on any other refuelling.
 */
function recentRefuelPart(payload: FuelCreatedPayload): string {
  if (!payload.recentRefuelAt) return "";

  const reason = payload.recentRefuelReason
    ? ` (motivo: ${payload.recentRefuelReason})`
    : "";

  return ` | Alerta: outro abastecimento do veículo às ${payload.recentRefuelAt}${reason}`;
}

function renderFuelCreatedActivity(
  payload: FuelCreatedPayload,
): RenderedActivity {
  // Origin matters in the trail: it tells apart what the driver registered
  // at the pump from what the office typed in later. It stays the last
  // part, as on the checklist, whose created_from backfill reads it there.
  const originPart = payload.origin
    ? ` | Origem: ${payload.origin === "MOBILE_APP" ? "Aplicativo" : "Web"}`
    : "";

  return {
    type: "Abastecimento",
    action: "create",
    entityId: payload.fuelId,
    description: `Abastecimento criado para o veículo ${payload.vehiclePlate} - ${payload.vehicleDescription}${recentRefuelPart(payload)}${originPart}`,
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
