import { describe, expect, it, vi } from "vitest";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import { webhookEndpointDisabledPolicy } from "@/shared/notifications/policies/webhook-endpoint-policies";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { WebhookEndpointDisabledPayload } from "@/shared/notifications/notification-types";

/**
 * The notice that an endpoint was switched off.
 *
 * The breaker used to trip in silence: the company learnt its ERP had stopped
 * receiving events when the reconciliation did not close, days later.
 */
const payload: WebhookEndpointDisabledPayload = {
  businessId: "018f0000-0000-7000-8000-00000000000a",
  endpointId: "018f0000-0000-7000-8000-0000000000e1",
  endpointName: "ERP Protheus",
  url: "https://erp.exemplo.com.br/webhooks",
  reason: "20 falhas seguidas.",
  disabledAt: "2026-09-24T05:00:00.000Z",
};

describe("webhook-endpoint.disabled", () => {
  it("is registered, so the pipeline does not fail the event", () => {
    expect(notificationPolicies["webhook-endpoint.disabled"]).toBe(
      webhookEndpointDisabledPolicy,
    );
  });

  it("goes to the company's admins, whatever their preferences", async () => {
    const findBusinessAdminsByBusinessId = vi.fn(async () => []);

    await webhookEndpointDisabledPolicy.resolveRecipients(payload, {
      userRepository: {
        findBusinessAdminsByBusinessId,
      } as unknown as IUserRepository,
    });

    expect(findBusinessAdminsByBusinessId).toHaveBeenCalledWith(
      payload.businessId,
    );
    expect(webhookEndpointDisabledPolicy.mandatory).toBe(true);
  });

  it("says which endpoint, why, and that the events are being kept", () => {
    const rendered = webhookEndpointDisabledPolicy.renderInApp!(
      payload,
      { baseUrl: "https://app.trajetto.com.br" },
      { id: "u1", role: "BUSINESS_ADMIN" },
    );

    expect(rendered.title).toContain("ERP Protheus");
    expect(rendered.message).toContain(payload.url);
    expect(rendered.message).toContain("20 falhas seguidas");
    expect(rendered.message).toMatch(/guardados por até 30 dias/);
    expect(rendered.link).toBe(
      "https://app.trajetto.com.br/dashboard/integrations?tab=webhooks",
    );
    expect(rendered.entityId).toBe(payload.endpointId);
  });
});
