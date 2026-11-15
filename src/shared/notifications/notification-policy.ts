import {
  NotificationPolicyEntry,
  NotificationTopic,
  TopicPayloadMap,
} from "./notification-types";

import { fineCreatedPolicy } from "./policies/fine-created-policy";
import { vehicleChecklistCreatedPolicy } from "./policies/vehicle-checklist-created-policy";
import { vehicleChecklistDefectsFoundPolicy } from "./policies/vehicle-checklist-defects-policy";
import { fuelCreatedPolicy } from "./policies/fuel-created-policy";
import { aiVerificationIssuePolicy } from "./policies/ai-verification-issue-policy";
import { serviceOrderCreatedPolicy } from "./policies/service-order-created-policy";
import { serviceOrderUpdatedPolicy } from "./policies/service-order-updated-policy";
import { accountPayableCreatedPolicy } from "./policies/account-payable-created-policy";
import { accountPayableUpdatedPolicy } from "./policies/account-payable-updated-policy";
import {
  kanbanCardCreatedPolicy,
  kanbanCardUpdatedPolicy,
} from "./policies/kanban-card-policies";
import { activityRecordedPolicy } from "./policies/activity-recorded-policy";
import {
  businessLimitChangedPolicy,
  businessModuleChangedPolicy,
} from "./policies/business-plan-policies";
import { businessSettingsChangedPolicy } from "./policies/business-settings-policy";
import {
  deliveryOccurrenceAuthorizationDecidedPolicy,
  deliveryOccurrenceAuthorizationEscalatedPolicy,
  deliveryOccurrenceAuthorizationRequestedPolicy,
  deliveryOccurrenceReportedPolicy,
} from "./policies/delivery-occurrence-policy";
import { chatMessageSentPolicy } from "./policies/chat-message-policy";
import { deliveryStatusOverriddenPolicy } from "./policies/delivery-status-policy";
import {
  deliveryDeliveredPolicy,
  deliveryDispatchedPolicy,
  deliveryFailedPolicy,
  deliveryOnTheWayPolicy,
} from "./policies/delivery-customer-policy";

import {
  routeCancelledPolicy,
  routeLeftOpenPolicy,
  routePlanChangedPolicy,
  routeRecordBranchMissingPolicy,
  routeReleasedPolicy,
} from "./policies/route-policies";
import {
  masterUserAccountUpdatedPolicy,
  masterUserCreatedPolicy,
  masterUserUpdatedPolicy,
  masterUserWelcomedPolicy,
} from "./policies/master-user-policies";
import { webhookEndpointDisabledPolicy } from "./policies/webhook-endpoint-policies";
import { proofAIFeedbackPolicy } from "./policies/proof-ai-feedback-policy";
import {
  driverAccessNewDevicePolicy,
  driverAccessPasswordCreatedPolicy,
} from "./policies/driver-access-policies";

/**
 * Everything the system notifies, in one place.
 *
 * The map key is the outbox topic; publishing a topic that has no entry here
 * makes the event fail visibly in the pipeline (never silently), so adding a
 * feature's notification is: define the payload type, write the policy file,
 * register it here.
 *
 * Nobody is notified of what they just did (14/11/2026): the user whose
 * action published an event (the outbox row's `actorId`, which every publish
 * caused by a person carries) is left out of its recipients on every channel,
 * whatever the policy resolved. The exceptions say why in `notifiesActor`,
 * and are only these:
 * - "security": master-user.created and master-user.updated (the record of a
 *   privileged account the reader created or changed, decision D-49) and
 *   master-user.account-updated (about the reader's own account);
 * - "verdict": delivery-proof.ai-flagged (the AI's reading of the receipt the
 *   driver sent, for that driver).
 * tests/unitaires/notifications/actor-notice.test.ts holds the list and the
 * actor on every publish.
 */
const notificationPolicies: {
  [T in NotificationTopic]: NotificationPolicyEntry<TopicPayloadMap[T]>;
} = {
  "fine.created": fineCreatedPolicy,
  "vehicle-checklist.created": vehicleChecklistCreatedPolicy,
  // Plan of 02/11/2026 (F2): only a checklist with a defect publishes it.
  "vehicle-checklist.defects_found": vehicleChecklistDefectsFoundPolicy,
  "fuel.created": fuelCreatedPolicy,
  "ai-verification.issue": aiVerificationIssuePolicy,
  "service-order.created": serviceOrderCreatedPolicy,
  "service-order.updated": serviceOrderUpdatedPolicy,
  "account-payable.created": accountPayableCreatedPolicy,
  "account-payable.updated": accountPayableUpdatedPolicy,
  "kanban-card.created": kanbanCardCreatedPolicy,
  "kanban-card.updated": kanbanCardUpdatedPolicy,
  // Nothing publishes this topic any more: the audit trail is written
  // directly (NotificationService, GAP2-4). Kept for one release so events
  // queued by the previous image during a rolling deploy still drain instead
  // of failing as an unknown topic; remove it after that.
  "activity.recorded": activityRecordedPolicy,
  "master-user.created": masterUserCreatedPolicy,
  "master-user.welcomed": masterUserWelcomedPolicy,
  "master-user.updated": masterUserUpdatedPolicy,
  "master-user.account-updated": masterUserAccountUpdatedPolicy,
  "business-module.changed": businessModuleChangedPolicy,
  "business-limit.changed": businessLimitChangedPolicy,
  "business-settings.changed": businessSettingsChangedPolicy,
  "delivery-occurrence.reported": deliveryOccurrenceReportedPolicy,
  "delivery-occurrence.authorization_requested":
    deliveryOccurrenceAuthorizationRequestedPolicy,
  "delivery-occurrence.authorization_escalated":
    deliveryOccurrenceAuthorizationEscalatedPolicy,
  "delivery-occurrence.authorization_decided":
    deliveryOccurrenceAuthorizationDecidedPolicy,
  "chat-message.sent": chatMessageSentPolicy,
  "route.released": routeReleasedPolicy,
  "route.cancelled": routeCancelledPolicy,
  "route.plan_changed": routePlanChangedPolicy,
  // Plan of 02/11/2026, K11 (D26): a route left open, to the admins, once.
  "route.left_open": routeLeftOpenPolicy,
  // Wave 3.7: a driver's route record with no active branch, to the people
  // who run the deliveries, once per route and moment.
  "route.record_branch_missing": routeRecordBranchMissingPolicy,
  "delivery.status_overridden": deliveryStatusOverriddenPolicy,

  "delivery.dispatched": deliveryDispatchedPolicy,
  "delivery.on_the_way": deliveryOnTheWayPolicy,
  "delivery.delivered": deliveryDeliveredPolicy,
  "delivery.failed": deliveryFailedPolicy,

  "webhook-endpoint.disabled": webhookEndpointDisabledPolicy,

  "delivery-proof.ai-flagged": proofAIFeedbackPolicy,

  // Wave 2: a driver's login on a new phone, a password created after a QR.
  "driver-access.new_device": driverAccessNewDevicePolicy,
  "driver-access.password_created": driverAccessPasswordCreatedPolicy,
};

function getNotificationPolicy(
  topic: string,
): NotificationPolicyEntry<TopicPayloadMap[NotificationTopic]> | null {
  if (topic in notificationPolicies) {
    return notificationPolicies[topic as NotificationTopic];
  }

  return null;
}

export { notificationPolicies, getNotificationPolicy };
