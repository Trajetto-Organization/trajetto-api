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

describe("service-order.created WhatsApp render", () => {
  it("carries vehicle, value, mileage transition and id", () => {
    const text = renderServiceOrderCreatedWhatsApp(payload());

    expect(text).toContain("ABC1D23");
    expect(text).toContain("80000km → 80450km");
    expect(text).toContain("os-1");
  });

  it("drops the mileage line when there is no reading", () => {
    const text = renderServiceOrderCreatedWhatsApp({
      ...payload(),
      currentMileage: null,
      newMileage: null,
    });

    expect(text).not.toContain("Quilometragem");
  });

  it("falls back to N/A for a vehicle without plate", () => {
    const text = renderServiceOrderCreatedWhatsApp({
      ...payload(),
      vehiclePlate: null,
    });

    expect(text).toContain("Veículo: *N/A*");
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
