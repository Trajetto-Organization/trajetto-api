import { describe, expect, it } from "vitest";

import {
  canRegisterVehicle,
  canReactivateVehicle,
  occupiesFleetSlot,
  isModuleEnabled,
} from "@/shared/entitlements/entitlement-rules";

describe("vehicle quota", () => {
  /**
   * 0 = "not configured": enforcement is an opt-in that starts when the
   * master fills the field — companies that predate it keep working.
   */
  it("never blocks while the limit is not configured", () => {
    expect(canRegisterVehicle(500, 0).allowed).toBe(true);
  });

  it("allows below the limit", () => {
    expect(canRegisterVehicle(9, 10).allowed).toBe(true);
  });

  it("blocks at the limit with an actionable message", () => {
    const verdict = canRegisterVehicle(10, 10);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("10/10");
  });

  /**
   * Lowering the limit below the current fleet must not corrupt anything:
   * existing vehicles stay, only new registrations are blocked.
   */
  it("blocks when the fleet already exceeds a lowered limit", () => {
    expect(canRegisterVehicle(15, 10).allowed).toBe(false);
  });
});

describe("fleet slots", () => {
  /**
   * Only INACTIVE frees a contracted slot — that is the customer's
   * self-service lever when the plan shrinks. BLOCKED and IN_ROUTE are
   * temporary operational states and still occupy their slot.
   */
  it("every status but INACTIVE occupies a slot", () => {
    expect(occupiesFleetSlot("ACTIVE")).toBe(true);
    expect(occupiesFleetSlot("BLOCKED")).toBe(true);
    expect(occupiesFleetSlot("IN_ROUTE")).toBe(true);
    expect(occupiesFleetSlot("INACTIVE")).toBe(false);
  });
});

describe("vehicle reactivation", () => {
  it("never blocks while the limit is not configured", () => {
    expect(canReactivateVehicle(500, 0).allowed).toBe(true);
  });

  it("allows when a slot is free", () => {
    expect(canReactivateVehicle(19, 20).allowed).toBe(true);
  });

  /**
   * Closes the swap loophole: inactivate 14, register 14 new, reactivate
   * the old 14 would otherwise put 34 active vehicles on a 20 plan.
   */
  it("blocks reactivation when the active fleet fills the plan", () => {
    const verdict = canReactivateVehicle(20, 20);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("reativar");
  });
});

describe("module gate", () => {
  it("a missing row means never hired", () => {
    expect(isModuleEnabled([], "DELIVERIES")).toBe(false);
  });

  it("a disabled row means hired and switched off", () => {
    expect(
      isModuleEnabled([{ module: "DELIVERIES", enabled: false }], "DELIVERIES"),
    ).toBe(false);
  });

  it("enabled row grants access", () => {
    expect(
      isModuleEnabled(
        [
          { module: "FLEET", enabled: true },
          { module: "DELIVERIES", enabled: false },
        ],
        "FLEET",
      ),
    ).toBe(true);
  });
});
