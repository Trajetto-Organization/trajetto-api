import { afterEach, describe, expect, it, vi } from "vitest";

import { createDriverSchema } from "@/schemas/create-driver-schema";
import { updateDriverSchema } from "@/schemas/update-driver-schema";

/**
 * The birth date on the wire (decision 1.3): a civil day, the age counted on
 * civil days, and UTC midnight of that day stored.
 *
 * The old check read the server's calendar with getFullYear/getMonth/getDate:
 * in the UTC container São Paulo's evening is already tomorrow, and on a
 * machine in São Paulo "2008-09-29" (UTC midnight) read as the 28th. Both
 * accepted a driver the evening before their 18th birthday.
 */
function body(birth_date: string) {
  return {
    name: "Joana Motorista",
    birth_date,
    cnh: "12345678901",
    cpf: "52998224725",
    rg: "123456789",
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Flores",
    address_number: "10",
    status: "ACTIVE",
    contract_type: "OWNED",
  };
}

function at(instant: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the driver's age", () => {
  it("refuses the evening before the 18th birthday, when UTC is already on it", () => {
    // 22:30 on the 28th in São Paulo is 01:30 on the 29th in UTC.
    at("2026-09-29T01:30:00.000Z");

    for (const schema of [createDriverSchema, updateDriverSchema]) {
      const result = schema.safeParse(body("2008-09-29"));

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(
        "O motorista deve ter pelo menos 18 anos.",
      );
    }
  });

  it("accepts on the birthday itself, in the morning", () => {
    at("2026-09-29T12:00:00.000Z");

    expect(createDriverSchema.safeParse(body("2008-09-29")).success).toBe(true);
    expect(updateDriverSchema.safeParse(body("2008-09-29")).success).toBe(true);
  });

  it("refuses an impossible day and garbage from before 1900", () => {
    at("2026-09-29T12:00:00.000Z");

    expect(createDriverSchema.safeParse(body("1990-02-30")).success).toBe(false);
    expect(createDriverSchema.safeParse(body("0199-05-10")).success).toBe(false);
  });
});

describe("what is stored", () => {
  it("is UTC midnight of the civil day, from a date-only value", () => {
    const parsed = createDriverSchema.parse(body("1990-05-10"));

    expect(parsed.birth_date).toBeInstanceOf(Date);
    expect(parsed.birth_date.toISOString()).toBe("1990-05-10T00:00:00.000Z");
  });

  it("is the same day from the legacy form's local midnight", () => {
    const parsed = updateDriverSchema.parse(body("1990-05-10T03:00:00.000Z"));

    expect(parsed.birth_date.toISOString()).toBe("1990-05-10T00:00:00.000Z");
  });
});
