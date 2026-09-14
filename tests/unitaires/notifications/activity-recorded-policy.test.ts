import { describe, expect, it } from "vitest";

import {
  activityRecordedPolicy,
  renderActivityRecorded,
} from "@/shared/notifications/policies/activity-recorded-policy";

import type { PolicyDeps } from "@/shared/notifications/notification-types";

/**
 * The generic audit topic carries dozens of legacy call sites at once, so
 * what matters is that it changes nothing: no recipients, no channels, and a
 * byte-for-byte passthrough of the activity — including the hierarchical
 * visibility fields the MASTER-level activities depend on.
 */
describe("activity.recorded", () => {
  it("notifies nobody and renders nothing but the activity", async () => {
    expect(
      await activityRecordedPolicy.resolveRecipients(
        {
          type: "Fornecedor",
          action: "create",
          entityId: "sup-1",
          description: "Fornecedor criado",
          status: "Criado",
        },
        {} as PolicyDeps,
      ),
    ).toEqual([]);

    expect(activityRecordedPolicy.renderInApp).toBeUndefined();
    expect(activityRecordedPolicy.renderWhatsApp).toBeUndefined();
  });

  it("passes every field through untouched", () => {
    const rendered = renderActivityRecorded({
      type: "Usuário Master",
      action: "delete",
      entityId: "user-1",
      description: "Usuário master removido",
      status: "Completo",
      tenantName: "Empresa X",
      visibilityLevel: "MASTER",
      performingUserRole: "MASTER",
    });

    expect(rendered).toEqual({
      type: "Usuário Master",
      action: "delete",
      entityId: "user-1",
      description: "Usuário master removido",
      status: "Completo",
      tenantName: "Empresa X",
      visibilityLevel: "MASTER",
      performingUserRole: "MASTER",
    });
  });
});
