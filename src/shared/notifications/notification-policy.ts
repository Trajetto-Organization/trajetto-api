import {
  NotificationPolicyEntry,
  NotificationTopic,
  TopicPayloadMap,
} from "./notification-types";

import { fineCreatedPolicy } from "./policies/fine-created-policy";
import { vehicleChecklistCreatedPolicy } from "./policies/vehicle-checklist-created-policy";
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
import { deliveryOccurrenceReportedPolicy } from "./policies/delivery-occurrence-policy";
import { chatMessageSentPolicy } from "./policies/chat-message-policy";
import {
  masterUserAccountUpdatedPolicy,
  masterUserCreatedPolicy,
  masterUserUpdatedPolicy,
  masterUserWelcomedPolicy,
} from "./policies/master-user-policies";

/**
 * Everything the system notifies, in one place.
 *
 * The map key is the outbox topic; publishing a topic that has no entry here
 * makes the event fail visibly in the pipeline (never silently), so adding a
 * feature's notification is: define the payload type, write the policy file,
 * register it here.
 */
const notificationPolicies: {
  [T in NotificationTopic]: NotificationPolicyEntry<TopicPayloadMap[T]>;
} = {
  "fine.created": fineCreatedPolicy,
  "vehicle-checklist.created": vehicleChecklistCreatedPolicy,
  "fuel.created": fuelCreatedPolicy,
  "ai-verification.issue": aiVerificationIssuePolicy,
  "service-order.created": serviceOrderCreatedPolicy,
  "service-order.updated": serviceOrderUpdatedPolicy,
  "account-payable.created": accountPayableCreatedPolicy,
  "account-payable.updated": accountPayableUpdatedPolicy,
  "kanban-card.created": kanbanCardCreatedPolicy,
  "kanban-card.updated": kanbanCardUpdatedPolicy,
  "activity.recorded": activityRecordedPolicy,
  "master-user.created": masterUserCreatedPolicy,
  "master-user.welcomed": masterUserWelcomedPolicy,
  "master-user.updated": masterUserUpdatedPolicy,
  "master-user.account-updated": masterUserAccountUpdatedPolicy,
  "business-module.changed": businessModuleChangedPolicy,
  "business-limit.changed": businessLimitChangedPolicy,
  "delivery-occurrence.reported": deliveryOccurrenceReportedPolicy,
  "chat-message.sent": chatMessageSentPolicy,
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
