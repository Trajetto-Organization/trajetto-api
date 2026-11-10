import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import { isValidCpf, normalizeCpf } from "@/modules/user/services/driver-cpf";
import { createDriverSchema } from "@/schemas/create-driver-schema";
import { driverCpfField } from "@/schemas/driver-access-schema";
import { updateDriverSchema } from "@/schemas/update-driver-schema";

import { validCpf } from "../../support/valid-cpf";

/**
 * The CPF on the driver's record, on create and on update. Only the length
 * was checked: "111.111.111-11" or a CPF with a wrong check digit was stored
 * without a word, and that driver could never sign in by CPF, because the
 * login (driver-cpf.ts) refuses it before reading a single record.
 *
 * The valid samples are generated CPFs (check digits computed), not
 * anybody's. The messages are the web's (src/schemas/cpf-field), word for
 * word: its cpf-field-api-parity test runs these schemas.
 */
const REQUIRED = "O CPF é obrigatório.";
const LENGTH = "O CPF deve ter exatamente 11 dígitos.";
const INVALID = "O CPF informado não é válido.";

const fields = [
  ["create", createDriverSchema.shape.cpf],
  ["update", updateDriverSchema.shape.cpf],
] as const;

/**
 * Valid CPFs spread over the range (generated bases, check digits computed),
 * each with its two near misses: the last digit changed, then the one
 * before it. One sample in three is valid, and every refusal is one digit
 * away from a CPF.
 */
function cpfSamples(count: number): { valid: string[]; nearMisses: string[] } {
  const valid: string[] = [];
  const nearMisses: string[] = [];
  const bump = (cpf: string, index: number) =>
    `${cpf.slice(0, index)}${(Number(cpf[index]) + 1) % 10}${cpf.slice(index + 1)}`;

  for (let seed = 0; seed < count; seed += 1) {
    const cpf = validCpf(
      String((seed * 7_919_317_351 + 12_345) % 1_000_000_000).padStart(9, "0"),
    );

    valid.push(cpf);
    nearMisses.push(bump(cpf, 10), bump(cpf, 9));
  }

  return { valid, nearMisses };
}

const messagesOf = (field: ZodTypeAny, value: unknown): string[] => {
  const result = field.safeParse(value);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe.each(fields)("the CPF on %s", (_label, field) => {
  it("keeps the 11 digits of a valid CPF, masked or not", () => {
    expect(field.parse("52998224725")).toBe("52998224725");
    expect(field.parse("529.982.247-25")).toBe("52998224725");
    expect(field.parse(" 111 444 777 35 ")).toBe("11144477735");
    // The first check digit is 0: (sum × 10) mod 11 is 10 here.
    expect(field.parse("123.456.789-09")).toBe("12345678909");
  });

  it("refuses a wrong check digit and a repeated digit, saying it is not valid", () => {
    expect(messagesOf(field, "529.982.247-24")).toEqual([INVALID]);
    expect(messagesOf(field, "52998224715")).toEqual([INVALID]);

    for (let digit = 0; digit <= 9; digit += 1) {
      expect(messagesOf(field, String(digit).repeat(11))).toEqual([INVALID]);
    }
  });

  it("says how many digits it takes when the count is wrong", () => {
    expect(messagesOf(field, "529.982.247-2")).toEqual([LENGTH]);
    expect(messagesOf(field, "529982247250")).toEqual([LENGTH]);
  });

  it("never turns letters or other symbols into somebody's CPF", () => {
    // The old rule dropped every non-digit: "529a982.247-25" became valid.
    expect(messagesOf(field, "529a982.247-25")).toEqual([INVALID]);
    expect(messagesOf(field, "529/982/247-25")).toEqual([INVALID]);
  });

  it("calls an empty or mask-only value missing", () => {
    expect(messagesOf(field, "")).toEqual([REQUIRED]);
    expect(messagesOf(field, "...-")).toEqual([REQUIRED]);
    expect(messagesOf(field, 52998224725)).toEqual([REQUIRED]);
  });

  it("accepts exactly what the login accepts, and stores what it compares", () => {
    const { valid, nearMisses } = cpfSamples(300);

    for (const cpf of [
      "52998224725",
      "11144477735",
      "00000000000",
      ...valid,
      ...nearMisses,
    ]) {
      const result = field.safeParse(cpf);

      expect(result.success ? result.data : null, cpf).toBe(normalizeCpf(cpf));
    }

    // Both sides really exercised: random 11 digits are valid about once in
    // a hundred, so the comparison above would be refusal against refusal.
    for (const cpf of valid)
      expect(field.safeParse(cpf).success, cpf).toBe(true);
    for (const cpf of nearMisses) {
      expect(field.safeParse(cpf).success, cpf).toBe(false);
    }
  });
});

describe("the CPF at the login", () => {
  it("says the record's words (one constant, src/schemas/driver-cpf-field)", () => {
    expect(messagesOf(driverCpfField, "111.111.111-11")).toEqual([INVALID]);
    expect(messagesOf(driverCpfField, "529.982.247-24")).toEqual([INVALID]);
    expect(messagesOf(driverCpfField, undefined)).toEqual([REQUIRED]);
  });
});

describe("the CPF on the record as a whole", () => {
  it("is required on create, in Portuguese", () => {
    const result = createDriverSchema.safeParse({});
    const cpf = result.success
      ? undefined
      : result.error.flatten().fieldErrors.cpf;

    expect(cpf).toEqual([REQUIRED]);
  });

  it("may be left out of an edit, and is checked whenever it is sent", () => {
    const edit = { birth_date: "1990-05-10" };

    expect(updateDriverSchema.safeParse(edit).success).toBe(true);

    const result = updateDriverSchema.safeParse({
      ...edit,
      cpf: "111.111.111-11",
    });

    expect(result.success).toBe(false);
    expect(
      result.success ? undefined : result.error.flatten().fieldErrors.cpf,
    ).toEqual([INVALID]);
  });
});

describe("the tests' validCpf (tests/support/valid-cpf.ts)", () => {
  it("builds, from any mixed 9-digit base, a CPF the API accepts", () => {
    expect(validCpf("529982247")).toBe("52998224725");
    expect(validCpf("123456789")).toBe("12345678909");

    for (let seed = 1; seed <= 200; seed += 1) {
      const base = `8${String(seed).padStart(8, "0")}`;

      expect(isValidCpf(validCpf(base)), base).toBe(true);
    }
  });

  it("refuses a base that is not 9 digits", () => {
    expect(() => validCpf("12345678")).toThrow();
    expect(() => validCpf("12345678a")).toThrow();
  });
});
