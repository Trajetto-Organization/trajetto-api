import { describe, expect, it } from "vitest";

import { DeliveryStatus } from "@prisma/client";

import { canTransitionDelivery } from "@/shared/delivery/delivery-rules";
import {
  INTEGRATION_CANCEL_VERDICTS,
  integrationCancelVerdict,
  isNotCancellable,
  NOT_CANCELLABLE_STATUSES,
} from "@/shared/integration/cancel-delivery-rules";
import { NOT_CANCELLABLE_MESSAGES } from "@/modules/integration/usecases/cancel-delivery/cancel-integration-delivery-errors";

/**
 * What the public cancel does with each status (L9, D49; owner's decisions:
 * Pendente and Insucesso only, Em rota refused for now).
 */
describe("the public cancel's verdict", () => {
  it("cancels a pending delivery and a failed one", () => {
    expect(integrationCancelVerdict("PENDING")).toBe("CANCEL");
    expect(integrationCancelVerdict("FAILED")).toBe("CANCEL");
  });

  it("answers an already cancelled delivery as a replay", () => {
    expect(integrationCancelVerdict("CANCELLED")).toBe("REPLAY");
  });

  it("refuses a delivered one and one on the truck", () => {
    expect(integrationCancelVerdict("DELIVERED")).toBe("REFUSE");
    expect(integrationCancelVerdict("IN_TRANSIT")).toBe("REFUSE");
    expect(isNotCancellable("DELIVERED")).toBe(true);
    expect(isNotCancellable("IN_TRANSIT")).toBe(true);
    expect(isNotCancellable("PENDING")).toBe(false);
  });

  it("cancels only what the status machine lets move to CANCELLED", () => {
    // The write goes through the panel's core, which trusts its caller to
    // have asked the machine: the table must never say CANCEL where the
    // machine says no.
    for (const [status, verdict] of Object.entries(
      INTEGRATION_CANCEL_VERDICTS,
    )) {
      if (verdict !== "CANCEL") continue;

      expect(
        canTransitionDelivery(status as never, "CANCELLED").allowed,
        status,
      ).toBe(true);
    }
  });

  it("decides every status of the database's enum, so a new one does not pass in silence", () => {
    expect(Object.keys(INTEGRATION_CANCEL_VERDICTS).sort()).toEqual(
      Object.values(DeliveryStatus).sort(),
    );
  });

  it("has a sentence for every status it refuses", () => {
    const refused = Object.entries(INTEGRATION_CANCEL_VERDICTS)
      .filter(([, verdict]) => verdict === "REFUSE")
      .map(([status]) => status)
      .sort();

    expect(Object.keys(NOT_CANCELLABLE_MESSAGES).sort()).toEqual(refused);
    expect(NOT_CANCELLABLE_MESSAGES.IN_TRANSIT).toMatch(/painel/);
  });

  it("lists the refused statuses for the published 409, in the table's order", () => {
    expect(NOT_CANCELLABLE_STATUSES).toEqual(["IN_TRANSIT", "DELIVERED"]);
    expect(NOT_CANCELLABLE_STATUSES.every(isNotCancellable)).toBe(true);
  });
});
