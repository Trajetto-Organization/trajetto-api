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

/** Intl puts a non-breaking space after "R$"; the registry flattens it before the send. */
function plainSpaces<T extends { parameters: ReadonlyArray<unknown> }>(
  rendered: T,
): T {
  return {
    ...rendered,
    parameters: rendered.parameters.map((value) =>
      typeof value === "string" ? value.replace(/\s/g, " ") : value,
    ),
  };
}

describe("account-payable.created in-app render", () => {
  it("links a driver to the driver route", () => {
    const rendered = renderAccountPayableCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_USER",
      driverId: "drv-1",
    });

    expect(rendered.link).toBe(
      "https://app.trajetto.com/driver/account-payable",
    );
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

/**
 * Plan of 02/11/2026 (B1): trajetto_conta_pagar, with the value first (it is
 * what the notification preview shows) and the linked order by its short
 * code — never the raw id a person cannot use.
 */
describe("account-payable.created WhatsApp render", () => {
  it("names its template, with the value first and every field in order", () => {
    const rendered = plainSpaces(
      renderAccountPayableCreatedWhatsApp({
        ...payload(),
        serviceOrderId: "018f0000-0000-7000-8000-8f2c4a9e1b3d",
        payeeName: "Auto Center Rota Sul",
        dueDate: "2026-11-10T12:00:00.000Z",
        timeZone: "America/Sao_Paulo",
        category: "OTHER",
        categoryDescription: "Guincho",
        description: "Revisão\ndo caminhão",
        serviceOrderVehiclePlate: "RTA4F21",
      }),
    );

    expect(rendered).toEqual({
      template: "trajetto_conta_pagar",
      parameters: [
        "R$ 780,90",
        "Auto Center Rota Sul",
        "10/11/2026",
        "Outros (Guincho)",
        "Revisão do caminhão",
        "8f2c4a9e1b3d (veículo RTA4F21)",
      ],
    });
  });

  /**
   * An event queued before the new fields existed still goes out: what it
   * lacks becomes the variable's fallback when the registry fits it.
   */
  it("leaves to the fallbacks what an older event does not carry", () => {
    const rendered = plainSpaces(
      renderAccountPayableCreatedWhatsApp({
        ...payload(),
        serviceOrderId: null,
      }),
    );

    expect(rendered.parameters).toEqual([
      "R$ 780,90",
      null,
      null,
      null,
      null,
      null,
    ]);
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
