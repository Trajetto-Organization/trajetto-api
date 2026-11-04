import { describe, expect, it } from "vitest";

import {
  serviceOrderUpdatedPolicy,
  renderServiceOrderUpdatedInApp,
} from "@/shared/notifications/policies/service-order-updated-policy";

import {
  accountPayableUpdatedPolicy,
  renderAccountPayableUpdatedWhatsApp,
} from "@/shared/notifications/policies/account-payable-updated-policy";

import type {
  PolicyDeps,
  ServiceOrderUpdatedPayload,
} from "@/shared/notifications/notification-types";

const serviceOrderPayload = (): ServiceOrderUpdatedPayload => ({
  serviceOrderId: "os-1",
  businessId: "biz-1",
  vehicleId: "veh-1",
  vehiclePlate: "ABC1D23",
  totalAmount: 900,
  responsibleUserId: null,
});

/**
 * The hand-over rule is the point of both update topics: an ordinary edit
 * must stay silent (activity only), and only a newly assigned responsible is
 * paged. The payload carries null when nothing was handed over — so an empty
 * recipient list must fall out of that without touching the database.
 */
describe("update topics page only on hand-over", () => {
  it("service order with no hand-over notifies nobody", async () => {
    expect(
      await serviceOrderUpdatedPolicy.resolveRecipients(
        serviceOrderPayload(),
        {} as PolicyDeps,
      ),
    ).toEqual([]);
  });

  it("account payable with no hand-over notifies nobody", async () => {
    expect(
      await accountPayableUpdatedPolicy.resolveRecipients(
        {
          accountPayableId: "ap-1",
          businessId: "biz-1",
          amount: 100,
          serviceOrderId: null,
          registrationUserId: null,
        },
        {} as PolicyDeps,
      ),
    ).toEqual([]);
  });

  it("service order render tells the new responsible what they inherited", () => {
    const rendered = renderServiceOrderUpdatedInApp(
      { ...serviceOrderPayload(), responsibleUserId: "user-9" },
      { baseUrl: "https://app.trajetto.com" },
      { id: "user-9", role: "BUSINESS_USER", driverId: "drv-1" },
    );

    expect(rendered.title).toBe("Ordem de Serviço Atualizada e Atribuída");
    expect(rendered.link).toBe(
      "https://app.trajetto.com/driver/vehicles/veh-1/service-orders",
    );
  });

  // Plan of 02/11/2026 (B1): the same template as the creation's.
  it("account payable WhatsApp uses the bill's template with the order's code", () => {
    const rendered = renderAccountPayableUpdatedWhatsApp({
      accountPayableId: "ap-1",
      businessId: "biz-1",
      amount: 100,
      serviceOrderId: "os-1",
      registrationUserId: "user-9",
    });

    expect(rendered.template).toBe("trajetto_conta_pagar");
    expect(String(rendered.parameters[0]).replace(/\s/g, " ")).toBe(
      "R$ 100,00",
    );
    // Not a UUID: the id goes whole.
    expect(rendered.parameters[5]).toBe("os-1");
  });
});
