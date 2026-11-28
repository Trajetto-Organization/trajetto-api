import { describe, expect, it } from "vitest";

import { NotificationCategory } from "@prisma/client";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import {
  renderVehicleChecklistDefectsInApp,
  vehicleChecklistDefectsFoundPolicy,
} from "@/shared/notifications/policies/vehicle-checklist-defects-policy";
import type {
  PolicyDeps,
  VehicleChecklistDefectsFoundPayload,
} from "@/shared/notifications/notification-types";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * A failed checklist alerts the fleet (plan of 02/11/2026, F2; decision
 * D44): the vehicle's responsible person (F1) when there is one, the
 * company's admins otherwise — under Maintenance, so each person's channel
 * choices for that category decide in-app, push and e-mail. Only published
 * when there is a defect (checklist-defects.ts), so a clean inspection
 * reaches nobody. The alert lands on the service-order form with the vehicle
 * and the defects filled in (F4: "Abrir OS" in one tap).
 */
const BUSINESS = "018feb00-0000-7000-8000-00000000000a";
const RESPONSIBLE = "018feb00-0000-7000-8000-0000000000a1";
const ADMIN = "018feb00-0000-7000-8000-0000000000a2";

const payload: VehicleChecklistDefectsFoundPayload = {
  checklistId: "018feb00-0000-7000-8000-0000000000c1",
  businessId: BUSINESS,
  vehicleId: "018feb00-0000-7000-8000-0000000000v1",
  vehiclePlate: "ABC1D23",
  vehicleDescription: "Caminhão Baú",
  responsibleUserId: RESPONSIBLE,
  defects: ["Freios", "Pneus"],
  verdict: "Reprovado",
};

function depsWith(users: Partial<User>[]): PolicyDeps {
  return {
    userRepository: {
      findUserById: async (id: string) =>
        (users.find((user) => user.id === id) as User | undefined) ?? null,
      findBusinessAdminsByBusinessId: async (businessId: string) =>
        users.filter(
          (user) =>
            user.role === "BUSINESS_ADMIN" && user.businessId === businessId,
        ) as User[],
    },
  } as unknown as PolicyDeps;
}

describe("the failed checklist alert", () => {
  it("is registered under Maintenance", () => {
    expect(notificationPolicies["vehicle-checklist.defects_found"]).toBe(
      vehicleChecklistDefectsFoundPolicy,
    );
    expect(vehicleChecklistDefectsFoundPolicy.category).toBe(
      NotificationCategory.MAINTENANCE,
    );
  });

  it("goes to the vehicle's responsible person", async () => {
    const recipients =
      await vehicleChecklistDefectsFoundPolicy.resolveRecipients(
        payload,
        depsWith([
          { id: RESPONSIBLE, role: "BUSINESS_USER", businessId: BUSINESS },
          { id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS },
        ]),
      );

    expect(recipients.map((user) => user.id)).toEqual([RESPONSIBLE]);
  });

  it("falls back to the admins without a responsible person", async () => {
    const recipients =
      await vehicleChecklistDefectsFoundPolicy.resolveRecipients(
        { ...payload, responsibleUserId: null },
        depsWith([{ id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS }]),
      );

    expect(recipients.map((user) => user.id)).toEqual([ADMIN]);
  });

  it("falls back to the admins when the responsible person is gone or moved", async () => {
    for (const users of [
      [{ id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS }],
      [
        { id: RESPONSIBLE, role: "BUSINESS_USER", businessId: "outra" },
        { id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS },
      ],
      // Offboarded by revoking the access (not deleted): the pipeline sends
      // nothing outside the product to them, so the alert would reach nobody.
      [
        {
          id: RESPONSIBLE,
          role: "BUSINESS_USER",
          businessId: BUSINESS,
          access_revoked: true,
        },
        { id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS },
      ],
    ] as Partial<User>[][]) {
      const recipients =
        await vehicleChecklistDefectsFoundPolicy.resolveRecipients(
          payload,
          depsWith(users),
        );

      expect(recipients.map((user) => user.id)).toEqual([ADMIN]);
    }
  });

  it("names the vehicle and the defects, and opens the service order pre-filled", () => {
    const rendered = renderVehicleChecklistDefectsInApp(
      payload,
      { baseUrl: "https://app.trajetto.com.br" } as never,
      { id: RESPONSIBLE, role: "BUSINESS_USER", driverId: null },
    );

    expect(rendered).toMatchObject({
      type: "vehicle-checklist-defect",
      title: "Checklist com defeito: ABC1D23",
      entityId: payload.checklistId,
    });
    expect(rendered.message).toBe(
      "O checklist do veículo ABC1D23 (Caminhão Baú) apontou defeito em Freios e Pneus. Situação: Reprovado.",
    );

    const link = new URL(rendered.link);

    expect(link.pathname).toBe("/dashboard/service-order");
    expect(link.searchParams.get("new")).toBe("1");
    expect(link.searchParams.get("vehicleId")).toBe(payload.vehicleId);
    expect(link.searchParams.get("checklistId")).toBe(payload.checklistId);
    expect(link.searchParams.get("description")).toBe(
      "Checklist com defeito: Freios, Pneus. Situação: Reprovado.",
    );
  });

  it("says only the verdict when no item failed", () => {
    const rendered = renderVehicleChecklistDefectsInApp(
      { ...payload, defects: [], verdict: "Aprovado com restrições" },
      { baseUrl: "https://app.trajetto.com.br" } as never,
      { id: ADMIN, role: "BUSINESS_ADMIN", driverId: null },
    );

    expect(rendered.message).toBe(
      "O checklist do veículo ABC1D23 (Caminhão Baú) foi registrado como Aprovado com restrições.",
    );
  });

  it("sends no WhatsApp (no approved template for it) and keeps the push default", () => {
    expect(vehicleChecklistDefectsFoundPolicy.renderWhatsApp).toBeUndefined();
    expect(vehicleChecklistDefectsFoundPolicy.pushTtlSeconds).toBeUndefined();
  });
});
