import { describe, expect, it } from "vitest";
import { NotificationCategory } from "@prisma/client";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import { preferenceCategoriesFor } from "@/modules/notification/usecases/manage-preferences/get-notification-preferences-usecase";

import type {
  NotificationPolicyEntry,
  NotificationTopic,
} from "@/shared/notifications/notification-types";

/**
 * The preference screen against the policy registry (14/11/2026).
 *
 * A policy names the category whose row decides its channels; the screen
 * shows each role only its catalog (preferenceCategoriesFor). The audit of
 * 14/11/2026 found the two apart: the plan notices (module, fleet size, AI
 * quota) and the webhook switched off sat in SYSTEM, a row no role is
 * shown, so their e-mail went out with no switch to stop it; and the admin
 * received ACCOUNT notices (a driver's new phone) with no "Conta" row.
 * These tests hold the two together whenever a topic is added or moved.
 */
type Audience = "MASTER" | "BUSINESS_ADMIN" | "OFFICE" | "DRIVER";

/** The role a person of each audience has, the one the catalog reads. */
const ROLE_OF: Record<Audience, string> = {
  MASTER: "MASTER",
  BUSINESS_ADMIN: "BUSINESS_ADMIN",
  OFFICE: "BUSINESS_USER",
  DRIVER: "BUSINESS_USER",
};

type AnyPolicy = NotificationPolicyEntry<unknown>;

const policies = Object.entries(notificationPolicies) as Array<
  [NotificationTopic, AnyPolicy]
>;

/**
 * The channels of a topic that a preference row decides: the bell and the
 * phone unless the topic is mandatory, the e-mail unless it is suppressed,
 * and the WhatsApp whenever there is one (pipeline-rules.ts).
 */
function governedChannels(policy: AnyPolicy): string[] {
  const channels: string[] = [];

  if ((policy.renderInApp || policy.renderPush) && !policy.mandatory) {
    channels.push("in-app");
  }

  if (policy.renderInApp && !policy.suppressEmail) channels.push("e-mail");
  if (policy.renderWhatsApp) channels.push("whatsapp");

  return channels;
}

/**
 * Who receives each topic a preference governs, read from its
 * resolveRecipients. A topic added with a governed channel must be listed
 * here, which is the point: someone decides whose screen shows its row.
 */
const AUDIENCE_OF: Partial<Record<NotificationTopic, Audience[]>> = {
  "fine.created": ["BUSINESS_ADMIN"],
  // The vehicle's responsible, or the admins when nobody is named.
  "vehicle-checklist.defects_found": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "ai-verification.issue": ["BUSINESS_ADMIN"],
  // The order's, the bill's or the card's responsible: anyone of the company.
  "service-order.created": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "service-order.updated": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "account-payable.created": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "account-payable.updated": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "kanban-card.created": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "kanban-card.updated": ["BUSINESS_ADMIN", "OFFICE", "DRIVER"],
  "master-user.created": ["MASTER"],
  "master-user.updated": ["MASTER"],
  "master-user.account-updated": ["MASTER"],
  // The other masters and the company's admins.
  "business-module.changed": ["MASTER", "BUSINESS_ADMIN"],
  "business-limit.changed": ["MASTER", "BUSINESS_ADMIN"],
  // The delivery operators: the admins and the office with the delivery key.
  "delivery-occurrence.reported": ["BUSINESS_ADMIN", "OFFICE"],
  "delivery-occurrence.authorization_requested": ["BUSINESS_ADMIN", "OFFICE"],
  "delivery-occurrence.authorization_escalated": ["BUSINESS_ADMIN"],
  "route.left_open": ["BUSINESS_ADMIN"],
  "route.record_branch_missing": ["BUSINESS_ADMIN", "OFFICE"],
  "webhook-endpoint.disabled": ["BUSINESS_ADMIN"],
  "driver-access.new_device": ["BUSINESS_ADMIN"],
  "driver-access.password_created": ["BUSINESS_ADMIN"],
};

describe("the notification preference catalog", () => {
  it("keeps every channel out of SYSTEM, the row no role is shown", () => {
    const withChannel = policies
      .filter(
        ([, policy]) =>
          policy.category === NotificationCategory.SYSTEM &&
          (policy.renderInApp || policy.renderWhatsApp || policy.renderPush),
      )
      .map(([topic]) => topic);

    expect(withChannel).toEqual([]);
  });

  it("names the audience of every topic a preference governs", () => {
    const governed = policies
      .filter(([, policy]) => governedChannels(policy).length > 0)
      .map(([topic]) => topic)
      .sort();

    expect(governed).toEqual(Object.keys(AUDIENCE_OF).sort());
  });

  it("puts each governed topic's row in the catalog of everyone who receives it", () => {
    const missing = policies.flatMap(([topic, policy]) =>
      (AUDIENCE_OF[topic] ?? [])
        .filter(
          (audience) =>
            !preferenceCategoriesFor(ROLE_OF[audience]).includes(
              policy.category,
            ),
        )
        .map(
          (audience) =>
            `${topic} (${policy.category}, ${governedChannels(policy).join(
              "/",
            )}) → ${audience}`,
        ),
    );

    expect(missing).toEqual([]);
  });

  it('shows the MASTER only the "Conta" row and the admin "Conta" too', () => {
    expect(preferenceCategoriesFor("MASTER")).toEqual([
      NotificationCategory.ACCOUNT,
    ]);
    expect(preferenceCategoriesFor("BUSINESS_ADMIN")).toContain(
      NotificationCategory.ACCOUNT,
    );
    expect(preferenceCategoriesFor("BUSINESS_USER")).not.toContain(
      NotificationCategory.ACCOUNT,
    );
    // An unknown role gets the narrowest catalog, never the admin's.
    expect(preferenceCategoriesFor("SOMETHING_NEW")).toEqual(
      preferenceCategoriesFor("BUSINESS_USER"),
    );
  });
});
