import { NotificationCategory } from "@prisma/client";

import type {
  BusinessSettingsChangedPayload,
  NotificationPolicyEntry,
  RenderedActivity,
} from "../notification-types";

import { TENANT_VISIBLE } from "./business-plan-policies";

/**
 * business-settings.changed — a company's own settings moved (plan of
 * 02/11/2026, M1): the checklist on the route or the geofence.
 *
 * An audit entry and nothing else. The settings are the company admin's own
 * decision, made on a screen they are looking at; the drivers' apps learn
 * of it through catalogChanged("settings") and the next payload, not through
 * a notice. A MASTER changing them on a company's behalf is shown to the
 * company (TENANT_VISIBLE), as their plan changes are.
 */

function renderBusinessSettingsChangedActivity(
  payload: BusinessSettingsChangedPayload,
): RenderedActivity {
  return {
    type: "Configurações da empresa",
    action: "update",
    entityId: payload.businessId,
    description: `${payload.description} | Empresa: ${payload.businessName}`,
    status: "Atualizado",
    tenantName: payload.businessName,
    visibilityLevel: TENANT_VISIBLE,
    performingUserRole: payload.actor.role,
  };
}

const businessSettingsChangedPolicy: NotificationPolicyEntry<BusinessSettingsChangedPayload> =
  {
    category: NotificationCategory.SYSTEM,

    async resolveRecipients() {
      return [];
    },

    renderActivity: renderBusinessSettingsChangedActivity,
  };

export { businessSettingsChangedPolicy, renderBusinessSettingsChangedActivity };
