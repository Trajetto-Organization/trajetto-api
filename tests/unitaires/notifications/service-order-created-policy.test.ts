import { describe, expect, it } from "vitest";

import {
  renderServiceOrderCreatedActivity,
  renderServiceOrderCreatedInApp,
  renderServiceOrderCreatedWhatsApp,
} from "@/shared/notifications/policies/service-order-created-policy";

import type { ServiceOrderCreatedPayload } from "@/shared/notifications/notification-types";

const payload = (): ServiceOrderCreatedPayload => ({
  serviceOrderId: "os-1",
  businessId: "biz-1",
  vehicleId: "veh-1",
  vehiclePlate: "ABC1D23",
  totalAmount: 1250.5,
  currentMileage: 80_000,
  newMileage: 80_450,
  isCompleted: false,
  responsibleUserId: "user-9",
});

const ctx = { baseUrl: "https://app.trajetto.com" };

describe("service-order.created in-app render", () => {
  /**
   * The link is the reason the render receives the recipient: the same order
   * lives at a different route for each role, and a driver sent to the
   * dashboard would land on a screen their session cannot open.
   */
  it("links a driver to the driver route", () => {
    const rendered = renderServiceOrderCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_USER",
      driverId: "drv-1",
    });

    expect(rendered.link).toBe(
      "https://app.trajetto.com/driver/vehicles/veh-1/service-orders",
    );
  });

  it("links an admin to the dashboard filtered by the order", () => {
    const rendered = renderServiceOrderCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_ADMIN",
      driverId: null,
    });

    expect(rendered.link).toBe(
      "https://app.trajetto.com/dashboard/service-order?search=os-1&page=1",
    );
  });

  it("tells the recipient they are the responsible", () => {
    const rendered = renderServiceOrderCreatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_ADMIN",
      driverId: null,
    });

    expect(rendered.title).toBe("Nova Ordem de Serviço");
    expect(rendered.message).toContain("responsável");
    expect(rendered.message).toContain("ABC1D23");
  });
});

/**
 * Plan of 02/11/2026 (B1): trajetto_ordem_servico, with the order's short
 * code instead of its raw id and the mileage in whole kilometres.
 */
describe("service-order.created WhatsApp render", () => {
  it("names its template, with vehicle, code, value and mileage in order", () => {
    const raw = renderServiceOrderCreatedWhatsApp({
      ...payload(),
      serviceOrderId: "018f0000-0000-7000-8000-8f2c4a9e1b3d",
      description: "Troca de óleo",
      maintenanceType: "EXTERNAL",
      orderDate: "2026-11-02T12:00:00.000Z",
      timeZone: "America/Sao_Paulo",
    });

    // Intl puts a non-breaking space after "R$"; the registry flattens it.
    const rendered = {
      ...raw,
      parameters: raw.parameters.map((value) =>
        typeof value === "string" ? value.replace(/\s/g, " ") : value,
      ),
    };

    expect(rendered).toEqual({
      template: "trajetto_ordem_servico",
      parameters: [
        "ABC1D23",
        "8f2c4a9e1b3d",
        "Troca de óleo",
        "Externa",
        "02/11/2026",
        "R$ 1.250,50",
        "80.000 km na abertura e 80.450 km após o serviço",
      ],
    });
  });

  it("leaves the mileage to its fallback when there is no reading", () => {
    const rendered = renderServiceOrderCreatedWhatsApp({
      ...payload(),
      currentMileage: null,
      newMileage: null,
    });

    expect(rendered.parameters[6]).toBeNull();
  });

  it("leaves a vehicle without plate to its fallback", () => {
    const rendered = renderServiceOrderCreatedWhatsApp({
      ...payload(),
      vehiclePlate: null,
    });

    expect(rendered.parameters[0]).toBeNull();
  });
});

describe("service-order.created activity render", () => {
  it("mirrors the order's completion into the activity status", () => {
    expect(renderServiceOrderCreatedActivity(payload()).status).toBe(
      "Pendente",
    );

    expect(
      renderServiceOrderCreatedActivity({ ...payload(), isCompleted: true })
        .status,
    ).toBe("Completo");
  });
});
