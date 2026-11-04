import { describe, expect, it } from "vitest";

import { isValidCpf, normalizeCpf } from "@/modules/user/services/driver-cpf";

/**
 * The CPF a driver types to sign in (plan of 02/11/2026, D8). The login
 * compares it with the 11 digits a driver is stored with, so the mask must
 * go, and a CPF whose check digits are wrong is refused on the screen before
 * any account is read: it is a typo, never a guess worth counting.
 *
 * The valid samples are generated CPFs (check digits computed by hand), not
 * anybody's.
 */
describe("normalizing the CPF typed at the login", () => {
  it("keeps the 11 digits of a valid CPF, masked or not", () => {
    expect(normalizeCpf("52998224725")).toBe("52998224725");
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
    expect(normalizeCpf(" 529 982 247 25 ")).toBe("52998224725");
    expect(normalizeCpf("111.444.777-35")).toBe("11144477735");
  });

  it("refuses wrong check digits", () => {
    expect(normalizeCpf("52998224726")).toBeNull();
    expect(normalizeCpf("52998224715")).toBeNull();
  });

  it("refuses the repeated digits that pass the arithmetic", () => {
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(normalizeCpf(String(digit).repeat(11))).toBeNull();
    }
  });

  it("refuses too few or too many digits", () => {
    expect(normalizeCpf("5299822472")).toBeNull();
    expect(normalizeCpf("529982247250")).toBeNull();
    expect(normalizeCpf("")).toBeNull();
  });

  it("never turns letters or other symbols into a CPF", () => {
    expect(normalizeCpf("529a98224725")).toBeNull();
    expect(normalizeCpf("529/982/247-25")).toBeNull();
    expect(normalizeCpf("52998224725@")).toBeNull();
  });
});

describe("the check digits", () => {
  it("accept a CPF whose first check digit is zero", () => {
    // (sum × 10) mod 11 is 10 here, which counts as 0.
    expect(isValidCpf("12345678909")).toBe(true);
  });

  it("only take the 11 bare digits", () => {
    expect(isValidCpf("529.982.247-25")).toBe(false);
  });
});
