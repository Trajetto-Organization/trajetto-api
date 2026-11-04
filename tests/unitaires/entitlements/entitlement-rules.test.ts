import { describe, expect, it } from "vitest";

import {
  LIMIT_ZERO_MEANING,
  canRegisterVehicle,
  canReactivateVehicle,
  isAIAnalysisEnabled,
  isVehicleLimitEnforced,
  occupiesFleetSlot,
  isModuleEnabled,
  isModuleSwitchedOff,
  masterModuleRefusal,
} from "@/shared/entitlements/entitlement-rules";
import { businessResponses } from "@/routes/documentation/business-documentation";
import { updateAILimitSchema } from "@/schemas/update-ai-limit-schema";
import { updateVehicleLimitSchema } from "@/schemas/update-vehicle-limit-schema";

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

describe("masterModuleRefusal", () => {
  const A = "company-a";
  const B = "company-b";

  it("lets on a request whose companies all hired the module", () => {
    expect(
      masterModuleRefusal(
        [A, B],
        [
          { id: A, isActive: true, moduleEnabled: true },
          { id: B, isActive: true, moduleEnabled: true },
        ],
      ),
    ).toBeNull();
  });

  it("blames the plan of an active company without the module", () => {
    expect(
      masterModuleRefusal(
        [A],
        [{ id: A, isActive: true, moduleEnabled: false }],
      ),
    ).toBe("module-not-enabled");
  });

  it("says a company does not exist before anything else", () => {
    expect(
      masterModuleRefusal(
        [A, B],
        [{ id: A, isActive: false, moduleEnabled: false }],
      ),
    ).toBe("company-not-found");
  });

  it("says a company is switched off before blaming its plan", () => {
    expect(
      masterModuleRefusal(
        [A, B],
        [
          { id: A, isActive: true, moduleEnabled: false },
          { id: B, isActive: false, moduleEnabled: false },
        ],
      ),
    ).toBe("company-inactive");
  });

  it("does not refuse a switched-off company that hired the module", () => {
    // The route's tenant gate answers for it, as it did before.
    expect(
      masterModuleRefusal(
        [A],
        [{ id: A, isActive: false, moduleEnabled: true }],
      ),
    ).toBeNull();
  });
});

/**
 * Plan M2: "0" means opposite things in the two limits that exist, and that
 * is kept on purpose — unifying it would switch the AI on for companies that
 * never bought it, or start blocking fleets whose limit was never filled.
 * The rule lives in one place (entitlement-rules) and every published field
 * says it, so nobody reads one limit with the other's zero.
 */
describe("what zero means in each limit (plan M2)", () => {
  it("is written down once, one meaning per limit", () => {
    expect(LIMIT_ZERO_MEANING).toEqual({
      vehicle_limit: "unlimited",
      ai_analysis_limit: "disabled",
    });
  });

  it("leaves a fleet of any size alone while vehicle_limit is 0", () => {
    expect(isVehicleLimitEnforced(0)).toBe(false);
    expect(isVehicleLimitEnforced(null)).toBe(false);
    expect(isVehicleLimitEnforced(undefined)).toBe(false);
    expect(isVehicleLimitEnforced(1)).toBe(true);

    // The verdicts follow the same rule, not a copy of it.
    expect(canRegisterVehicle(10_000, 0).allowed).toBe(true);
    expect(canReactivateVehicle(10_000, 0).allowed).toBe(true);
  });

  it("switches the AI off while ai_analysis_limit is 0", () => {
    expect(isAIAnalysisEnabled(0)).toBe(false);
    expect(isAIAnalysisEnabled(null)).toBe(false);
    expect(isAIAnalysisEnabled(undefined)).toBe(false);
    expect(isAIAnalysisEnabled(1)).toBe(true);
  });

  it("is stated on every published field that carries a limit", () => {
    const usage = businessResponses.aiUsageData.shape.data.shape;
    const aiLimitSaved = businessResponses.aiLimitUpdated.shape.data.shape;
    const plan = businessResponses.entitlementsData.shape.data.shape;

    for (const description of [
      usage.ai_analysis_limit.description,
      aiLimitSaved.ai_analysis_limit.description,
      updateAILimitSchema.shape.ai_analysis_limit.description,
    ]) {
      expect(description).toMatch(/0 = IA desligada/);
    }

    expect(usage.ai_analysis_enabled.description).toMatch(
      /`ai_analysis_limit` > 0/,
    );

    for (const description of [
      plan.vehicle_limit.description,
      updateVehicleLimitSchema.shape.vehicle_limit.description,
    ]) {
      expect(description).toMatch(/0 = sem limite/);
    }
  });
});

/**
 * Plan M3 (D51): switching Entregas off pauses the company's webhooks with
 * it. The pause follows the MASTER's switch — a row that exists and is off.
 * A company with no row never hired the module, so it could never register
 * an endpoint (the integration screens and the API key are gated): there is
 * nothing of its to hold.
 */
describe("a module switched off (the webhook pause)", () => {
  it("is a row that exists and is off", () => {
    expect(
      isModuleSwitchedOff(
        [
          { module: "FLEET", enabled: true },
          { module: "DELIVERIES", enabled: false },
        ],
        "DELIVERIES",
      ),
    ).toBe(true);
  });

  it("is not a module that is on", () => {
    expect(
      isModuleSwitchedOff(
        [{ module: "DELIVERIES", enabled: true }],
        "DELIVERIES",
      ),
    ).toBe(false);
  });

  it("is not a module that was never hired", () => {
    expect(isModuleSwitchedOff([], "DELIVERIES")).toBe(false);
    expect(
      isModuleSwitchedOff([{ module: "FLEET", enabled: false }], "DELIVERIES"),
    ).toBe(false);
  });
});
