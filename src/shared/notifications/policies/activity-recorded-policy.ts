import { NotificationCategory } from "@prisma/client";

import {
  ActivityRecordedPayload,
  NotificationPolicyEntry,
  RenderedActivity,
} from "../notification-types";

/**
 * Passthrough policy for the generic audit-trail topic: the payload already
 * is the activity, nobody is notified, nothing is rendered beyond it.
 */

function renderActivityRecorded(
  payload: ActivityRecordedPayload,
): RenderedActivity {
  return {
    type: payload.type,
    action: payload.action,
    entityId: payload.entityId,
    description: payload.description,
    status: payload.status,
    tenantName: payload.tenantName,
    visibilityLevel: payload.visibilityLevel,
    performingUserRole: payload.performingUserRole,
  };
}

const activityRecordedPolicy: NotificationPolicyEntry<ActivityRecordedPayload> =
  {
    category: NotificationCategory.SYSTEM,

    async resolveRecipients() {
      return [];
    },

    renderActivity: renderActivityRecorded,
  };

export { activityRecordedPolicy, renderActivityRecorded };
