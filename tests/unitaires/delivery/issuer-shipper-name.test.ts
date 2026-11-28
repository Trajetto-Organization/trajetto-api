import { describe, expect, it } from "vitest";

import {
  issuerShipperName,
  SHIPPER_NAME_MAX,
} from "@/shared/delivery/issuer-shipper-name";

/**
 * Decision D-36 (14/11/2026): a filial's first NF-e was refused because its
 * corporate name was already the matriz's shipper, with another CNPJ. The
 * name stays unique; the filial's shipper takes it with the CNPJ's branch
 * number and check digits.
 */
describe("issuerShipperName", () => {
  it("adds the CNPJ's branch number and check digits", () => {
    expect(issuerShipperName("Magazine X", "12345678000290")).toBe(
      "Magazine X (0002-90)",
    );
  });

  it("reads a masked CNPJ by its digits", () => {
    expect(issuerShipperName("Magazine X", "12.345.678/0003-71")).toBe(
      "Magazine X (0003-71)",
    );
  });

  it("names nothing without a CNPJ of 14 digits", () => {
    expect(issuerShipperName("Magazine X", null)).toBeNull();
    expect(issuerShipperName("Magazine X", "12345678901")).toBeNull();
    expect(issuerShipperName("   ", "12345678000290")).toBeNull();
  });

  it("stays within the panel's limit, cutting the name and never the suffix", () => {
    const long = "A".repeat(SHIPPER_NAME_MAX);
    const named = issuerShipperName(long, "12345678000290");

    expect(named).toHaveLength(SHIPPER_NAME_MAX);
    expect(named?.endsWith(" (0002-90)")).toBe(true);
  });

  it("does not leave a space before the suffix when the cut lands on one", () => {
    const name = `${"B".repeat(SHIPPER_NAME_MAX - 11)} Ltda`;

    expect(issuerShipperName(name, "12345678000290")).toBe(
      `${"B".repeat(SHIPPER_NAME_MAX - 11)} (0002-90)`,
    );
  });
});
