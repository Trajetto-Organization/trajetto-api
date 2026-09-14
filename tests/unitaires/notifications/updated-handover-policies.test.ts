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

  it("account payable WhatsApp closes the order id formatting", () => {
    const text = renderAccountPayableUpdatedWhatsApp({
      accountPayableId: "ap-1",
      businessId: "biz-1",
      amount: 100,
      serviceOrderId: "os-1",
      registrationUserId: "user-9",
    });

    expect(text).toContain("Identificador da ordem de serviço: *os-1*");
  });
});
