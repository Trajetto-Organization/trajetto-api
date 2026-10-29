import { describe, expect, it } from "vitest";

import {
  canTransitionDelivery,
  isTerminalDeliveryStatus,
  statusAfterOccurrence,
} from "@/shared/delivery/delivery-rules";

describe("delivery status machine", () => {
  it("follows the happy path PENDING → IN_TRANSIT → DELIVERED", () => {
    expect(canTransitionDelivery("PENDING", "IN_TRANSIT").allowed).toBe(true);
    expect(canTransitionDelivery("IN_TRANSIT", "DELIVERED").allowed).toBe(true);
  });

  it("supports redelivery: FAILED → PENDING → IN_TRANSIT", () => {
    expect(canTransitionDelivery("FAILED", "PENDING").allowed).toBe(true);
    expect(canTransitionDelivery("PENDING", "IN_TRANSIT").allowed).toBe(true);
  });

  it("allows the truck to return to base: IN_TRANSIT → PENDING", () => {
    expect(canTransitionDelivery("IN_TRANSIT", "PENDING").allowed).toBe(true);
  });

  it("never delivers straight from PENDING (proof requires a route)", () => {
    const verdict = canTransitionDelivery("PENDING", "DELIVERED");

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("Pendente");
  });

  it("treats DELIVERED and CANCELLED as terminal", () => {
    expect(isTerminalDeliveryStatus("DELIVERED")).toBe(true);
    expect(isTerminalDeliveryStatus("CANCELLED")).toBe(true);

    expect(canTransitionDelivery("DELIVERED", "PENDING").allowed).toBe(false);
    expect(canTransitionDelivery("CANCELLED", "PENDING").allowed).toBe(false);
  });

  it("rejects a no-op transition with a clear message", () => {
    const verdict = canTransitionDelivery("PENDING", "PENDING");

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("já está");
  });
});

describe("occurrence effect on status", () => {
  it("a blocking occurrence flips an active delivery to FAILED", () => {
    expect(statusAfterOccurrence("IN_TRANSIT", true)).toBe("FAILED");
    expect(statusAfterOccurrence("PENDING", true)).toBe("FAILED");
  });

  it("an informational occurrence keeps the status", () => {
    expect(statusAfterOccurrence("IN_TRANSIT", false)).toBe("IN_TRANSIT");
  });

  it("never moves a terminal delivery", () => {
    expect(statusAfterOccurrence("DELIVERED", true)).toBe("DELIVERED");
    expect(statusAfterOccurrence("CANCELLED", true)).toBe("CANCELLED");
  });
});
