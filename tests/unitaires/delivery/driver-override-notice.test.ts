import { describe, expect, it } from "vitest";

import {
  DRIVER_WORKLIST_STATUSES,
  driverShouldHearOverride,
  isOnDriverWorklist,
} from "@/shared/delivery/driver-worklist";

import { renderDeliveryStatusOverriddenPush } from "@/shared/notifications/policies/delivery-status-policy";
import type { DeliveryStatusOverriddenPayload } from "@/shared/notifications/notification-types";

/**
 * Whether a dispatcher's override reaches the driver's phone.
 *
 * The bug this exists for was silent and complete: the panel cancelled a
 * delivery at 10am, the driver's app dropped the row on the next sync, and
 * nothing anywhere told them. With a seven-day offline cache the gap is
 * longer, not shorter — the row can sit on the phone for hours after it
 * stopped being true, and then vanish with no explanation.
 *
 * The rule is a crossing of the working list, not "any change", because the
 * other half of the problem is noise: thirty drivers times a bell for every
 * bookkeeping move is how a notification system stops being read.
 */
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";

describe("the driver's working list", () => {
  it("is exactly what their app is served", () => {
    // `listDriverDeliveries` filters on these two and nothing else, so
    // membership here IS what the driver can see.
    expect(DRIVER_WORKLIST_STATUSES).toEqual(["PENDING", "IN_TRANSIT"]);
  });

  it("holds the two working statuses and no resolved one", () => {
    expect(isOnDriverWorklist("PENDING")).toBe(true);
    expect(isOnDriverWorklist("IN_TRANSIT")).toBe(true);

    expect(isOnDriverWorklist("DELIVERED")).toBe(false);
    expect(isOnDriverWorklist("FAILED")).toBe(false);
    expect(isOnDriverWorklist("CANCELLED")).toBe(false);
  });
});

describe("when the phone has to ring", () => {
  it("rings when a stop is taken off the list", () => {
    // The urgent one: the driver may be on the way to that address.
    for (const to of ["CANCELLED", "DELIVERED", "FAILED"] as const) {
      expect(
        driverShouldHearOverride({ from: "PENDING", to, driverId: DRIVER }),
        to,
      ).toBe(true);
    }
  });

  it("rings when a resolved delivery is put back on the list", () => {
    // Work the driver does not know they have is the same problem with the
    // sign flipped.
    expect(
      driverShouldHearOverride({
        from: "FAILED",
        to: "PENDING",
        driverId: DRIVER,
      }),
    ).toBe(true);
  });

  it("stays quiet on a move within the list", () => {
    // The dispatcher marking a load as departed changes nothing the driver
    // can act on, and their app already shows the stop.
    expect(
      driverShouldHearOverride({
        from: "PENDING",
        to: "IN_TRANSIT",
        driverId: DRIVER,
      }),
    ).toBe(false);
  });

  it("stays quiet on a move between two resolved statuses", () => {
    // Neither one was ever on the driver's screen.
    expect(
      driverShouldHearOverride({
        from: "FAILED",
        to: "CANCELLED",
        driverId: DRIVER,
      }),
    ).toBe(false);
  });

  it("stays quiet when nobody is carrying the delivery", () => {
    for (const driverId of [null, undefined, ""]) {
      expect(
        driverShouldHearOverride({
          from: "PENDING",
          to: "CANCELLED",
          driverId,
        }),
        String(driverId),
      ).toBe(false);
    }
  });

  it("stays quiet when the status did not actually move", () => {
    expect(
      driverShouldHearOverride({
        from: "PENDING",
        to: "PENDING",
        driverId: DRIVER,
      }),
    ).toBe(false);
  });
});

describe("what the lock screen says", () => {
  function payload(
    overrides: Partial<DeliveryStatusOverriddenPayload> = {},
  ): DeliveryStatusOverriddenPayload {
    return {
      deliveryId: "018f0000-0000-7000-8000-0000000000e1",
      businessId: "018f0000-0000-7000-8000-00000000000b",
      driverUserId: "018f0000-0000-7000-8000-0000000000a2",
      recipientName: "Padaria Central",
      addressLabel: "Praça da Sé, São Paulo",
      fromLabel: "Pendente",
      toLabel: "Cancelada",
      reason: "Cliente cancelou por telefone",
      note: null,
      removedFromWorklist: true,
      ...overrides,
    };
  }

  it("names the stop, the move and the reason", () => {
    const push = renderDeliveryStatusOverriddenPush(payload());

    expect(push.body).toContain("Padaria Central");
    expect(push.body).toContain("Praça da Sé");

    expect(push.body).toContain("Pendente");
    expect(push.body).toContain("Cancelada");

    expect(push.body).toContain("Cliente cancelou por telefone");
  });

  it("carries the operator's note when there is one", () => {
    // The detail the catalogue cannot carry, and the thing that actually
    // answers the driver's question.
    const push = renderDeliveryStatusOverriddenPush(
      payload({ note: "cliente ligou às 14h" }),
    );

    expect(push.body).toContain("cliente ligou às 14h");
  });

  it("reads differently for a stop lost and a stop gained", () => {
    const lost = renderDeliveryStatusOverriddenPush(payload());
    const gained = renderDeliveryStatusOverriddenPush(
      payload({ removedFromWorklist: false, toLabel: "Pendente" }),
    );

    expect(lost.title).not.toBe(gained.title);
    expect(lost.title).toContain("retirada");
  });

  it("opens the list, not the feed", () => {
    // What the driver needs is to see which stops are still theirs.
    expect(renderDeliveryStatusOverriddenPush(payload()).data).toEqual({
      url: "/deliveries",
    });
  });
});
