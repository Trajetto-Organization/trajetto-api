import { describe, expect, it } from "vitest";

import {
  renderVehicleChecklistCreatedActivity,
  vehicleChecklistCreatedPolicy,
} from "@/shared/notifications/policies/vehicle-checklist-created-policy";

import {
  renderFuelCreatedActivity,
  fuelCreatedPolicy,
} from "@/shared/notifications/policies/fuel-created-policy";

import type { PolicyDeps } from "@/shared/notifications/notification-types";

/**
 * These two topics are activity-only by design: routine per-vehicle events
 * would drown admins if pushed. The tests pin exactly that — recipients stay
 * empty and no in-app/WhatsApp render exists to accidentally grow one.
 */
describe("activity-only topics", () => {
  it("checklist notifies nobody and renders no in-app content", async () => {
    expect(
      await vehicleChecklistCreatedPolicy.resolveRecipients(
        {
          checklistId: "chk-1",
          businessId: "biz-1",
          vehiclePlate: "ABC1D23",
          vehicleDescription: "Caminhão Baú",
        },
        {} as PolicyDeps,
      ),
    ).toEqual([]);

    expect(vehicleChecklistCreatedPolicy.renderInApp).toBeUndefined();
    expect(vehicleChecklistCreatedPolicy.renderWhatsApp).toBeUndefined();
  });

  it("refuelling notifies nobody and renders no in-app content", async () => {
    expect(
      await fuelCreatedPolicy.resolveRecipients(
        {
          fuelId: "fuel-1",
          businessId: "biz-1",
          vehiclePlate: "ABC1D23",
          vehicleDescription: "Caminhão Baú",
        },
        {} as PolicyDeps,
      ),
    ).toEqual([]);

    expect(fuelCreatedPolicy.renderInApp).toBeUndefined();
    expect(fuelCreatedPolicy.renderWhatsApp).toBeUndefined();
  });

  it("checklist activity keeps the exact legacy wording", () => {
    const activity = renderVehicleChecklistCreatedActivity({
      checklistId: "chk-1",
      businessId: "biz-1",
      vehiclePlate: "ABC1D23",
      vehicleDescription: "Caminhão Baú",
    });

    expect(activity.type).toBe("Checklist Veicular");
    expect(activity.status).toBe("Criado");
    expect(activity.description).toBe(
      "Checklist veicular criado para o veículo ABC1D23 - Caminhão Baú",
    );
  });

  it("refuelling activity keeps the exact legacy wording", () => {
    const activity = renderFuelCreatedActivity({
      fuelId: "fuel-1",
      businessId: "biz-1",
      vehiclePlate: "ABC1D23",
      vehicleDescription: "Caminhão Baú",
    });

    expect(activity.type).toBe("Abastecimento");
    expect(activity.status).toBe("Criado");
    expect(activity.description).toBe(
      "Abastecimento criado para o veículo ABC1D23 - Caminhão Baú",
    );
  });
});
