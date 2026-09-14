import { describe, expect, it } from "vitest";

import {
  businessLimitChangedPolicy,
  businessModuleChangedPolicy,
  resolvePlanAudience,
} from "@/shared/notifications/policies/business-plan-policies";

import type { PolicyDeps } from "@/shared/notifications/notification-types";

const actor = {
  id: "master-1",
  name: "Gabriel",
  email: "gabriel@trajetto.com",
  role: "MASTER",
};

const ctx = { baseUrl: "https://app.trajetto.com" };

const modulePayload = {
  businessId: "biz-1",
  businessName: "Business Test",
  module: "DELIVERIES",
  enabled: false,
  previousEnabled: true,
  actor,
};

const limitPayload = {
  businessId: "biz-1",
  businessName: "Business Test",
  limit: "vehicle" as const,
  previousValue: 34,
  newValue: 20,
  actor,
};

function makeDeps(overrides: Record<string, unknown> = {}): PolicyDeps {
  return {
    userRepository: {
      findOtherMasters: async () => [
        { id: "master-2", role: "MASTER", access_revoked: false },
      ],
      findUsersByBusiness: async () => [
        { id: "admin-1", role: "BUSINESS_ADMIN", access_revoked: false },
        { id: "user-1", role: "BUSINESS_USER", access_revoked: false },
        { id: "admin-revoked", role: "BUSINESS_ADMIN", access_revoked: true },
      ],
      ...overrides,
    },
  } as unknown as PolicyDeps;
}

describe("business plan notification policies", () => {
  it("pages the other masters and the company admins, never the actor", async () => {
    const recipients = await resolvePlanAudience("biz-1", actor.id, makeDeps());
    const ids = recipients.map((recipient) => recipient.id);

    expect(ids).toContain("master-2");
    expect(ids).toContain("admin-1");

    // Collaborators do not administer the plan.
    expect(ids).not.toContain("user-1");

    // A revoked admin is not an audience.
    expect(ids).not.toContain("admin-revoked");

    // The actor confirmed a dialog two seconds ago; telling them is noise.
    expect(ids).not.toContain(actor.id);
  });

  it("does not page the same person twice", async () => {
    // A master who also carries a businessId would appear in both queries.
    const deps = makeDeps({
      findUsersByBusiness: async () => [
        { id: "master-2", role: "BUSINESS_ADMIN", access_revoked: false },
      ],
    });

    const recipients = await resolvePlanAudience("biz-1", actor.id, deps);
    expect(recipients).toHaveLength(1);
  });

  it("is mandatory, so a preference cannot silence a plan change", () => {
    expect(businessModuleChangedPolicy.mandatory).toBe(true);
    expect(businessLimitChangedPolicy.mandatory).toBe(true);
  });

  it("tells the master who did it and the admin what changed for them", () => {
    const forMaster = businessModuleChangedPolicy.renderInApp!(
      modulePayload,
      ctx,
      { id: "master-2", role: "MASTER" },
    );

    expect(forMaster.message).toContain("Gabriel");
    expect(forMaster.message).toContain("Business Test");
    expect(forMaster.link).toContain("/admin/business");

    const forAdmin = businessModuleChangedPolicy.renderInApp!(
      modulePayload,
      ctx,
      { id: "admin-1", role: "BUSINESS_ADMIN" },
    );

    // The fear this whole flow exists to answer.
    expect(forAdmin.message).toContain("nenhum dado foi apagado");
    expect(forAdmin.link).toContain("/dashboard");
  });

  it("records the movement, not just the destination", () => {
    const moduleActivity =
      businessModuleChangedPolicy.renderActivity!(modulePayload);

    expect(moduleActivity.description).toContain("habilitado → desabilitado");
    expect(moduleActivity.description).toContain("Entregas");

    // Without this marker the company would never see its own plan change.
    expect(moduleActivity.visibilityLevel).toBe("TENANT_VISIBLE");

    const limitActivity =
      businessLimitChangedPolicy.renderActivity!(limitPayload);

    expect(limitActivity.description).toContain("34 → 20");
    expect(limitActivity.visibilityLevel).toBe("TENANT_VISIBLE");
  });

  it("carries the change to WhatsApp for whoever configured a number", () => {
    expect(businessModuleChangedPolicy.renderWhatsApp!(modulePayload)).toContain(
      "Entregas",
    );

    expect(businessLimitChangedPolicy.renderWhatsApp!(limitPayload)).toContain(
      "34",
    );
  });
});
