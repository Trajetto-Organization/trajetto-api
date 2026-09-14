import { describe, expect, it } from "vitest";

import {
  renderAccountPayableCreatedActivity,
  renderAccountPayableCreatedInApp,
  renderAccountPayableCreatedWhatsApp,
} from "@/shared/notifications/policies/account-payable-created-policy";

import type { AccountPayableCreatedPayload } from "@/shared/notifications/notification-types";

const payload = (): AccountPayableCreatedPayload => ({
  accountPayableId: "ap-1",
  businessId: "biz-1",
  amount: 780.9,
  serviceOrderId: "os-1",
  registrationUserId: "user-9",
});

const ctx = { baseUrl: "https://app.trajetto.com" };

describe("account-payable.created in-app render", () => {
  it("links a driver to the driver route", () => {
    const rendered = renderAccountPayableCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_USER",
      driverId: "drv-1",
    });

    expect(rendered.link).toBe("https://app.trajetto.com/driver/account-payable");
  });

  it("links an admin to the dashboard filtered by the bill", () => {
    const rendered = renderAccountPayableCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_ADMIN",
      driverId: null,
    });

    expect(rendered.link).toBe(
      "https://app.trajetto.com/dashboard/account-payable?search=ap-1&page=1",
    );
  });

  it("mentions the linked service order only when there is one", () => {
    expect(
      renderAccountPayableCreatedInApp(payload(), ctx, {
        id: "user-9",
        role: "BUSINESS_ADMIN",
        driverId: null,
      }).message,
    ).toContain("os-1");

    expect(
      renderAccountPayableCreatedInApp(
        { ...payload(), serviceOrderId: null },
        ctx,
        { id: "user-9", role: "BUSINESS_ADMIN", driverId: null },
      ).message,
    ).not.toContain("ordem de serviço");
  });
});

describe("account-payable.created WhatsApp render", () => {
  it("carries value, bill id and linked order", () => {
    const text = renderAccountPayableCreatedWhatsApp(payload());

    expect(text).toContain("ap-1");
    expect(text).toContain("os-1");
  });

  /**
   * The old inline flow joined a falsy line without filtering, leaving a
   * blank line in the message when there was no linked order. This pins the
   * cleaned-up behavior.
   */
  it("drops the order line entirely when there is none", () => {
    const text = renderAccountPayableCreatedWhatsApp({
      ...payload(),
      serviceOrderId: null,
    });

    expect(text).not.toContain("ordem de serviço");
    expect(text).not.toContain("\n\n");
  });
});

describe("account-payable.created activity render", () => {
  it("records value and id", () => {
    const activity = renderAccountPayableCreatedActivity(payload());

    expect(activity.type).toBe("Conta a pagar");
    expect(activity.status).toBe("Completo");
    expect(activity.description).toContain("ap-1");
  });
});
