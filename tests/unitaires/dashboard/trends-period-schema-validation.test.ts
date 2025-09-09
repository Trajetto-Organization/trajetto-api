import { describe, it, expect } from "vitest";

import { trendsPeriodSchema } from "@/schemas/trends-period-schema";

describe("Trends Period Schema Validation", () => {
  it("should validate valid period values", () => {
    const validPeriods = ["7d", "30d", "3m", "6m", "12m"];

    validPeriods.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.period).toBe(period);
      }
    });
  });

  it("should reject invalid period values", () => {
    const invalidPeriods = [
      "1d",
      "14d",
      "1m",
      "2m",
      "24m",
      "1y",
      "day",
      "month",
      "year",
      "weekly",
      "monthly",
    ];

    invalidPeriods.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].code).toBe("invalid_enum_value");
        expect(result.error.issues[0].path).toEqual(["period"]);
      }
    });
  });

  it("should reject missing period field", () => {
    const payload = {};
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["period"]);

      expect(result.error.issues[0].message).toBe("Required");
    }
  });

  it("should reject null period value", () => {
    const payload = { period: null };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["period"]);
    }
  });

  it("should reject undefined period value", () => {
    const payload = { period: undefined };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["period"]);
    }
  });

  it("should reject empty string period value", () => {
    const payload = { period: "" };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_enum_value");
      expect(result.error.issues[0].path).toEqual(["period"]);
    }
  });

  it("should reject numeric period values", () => {
    const numericPeriods = [7, 30, 3, 6, 12];

    numericPeriods.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0].code).toBe("invalid_type");
        expect(result.error.issues[0].path).toEqual(["period"]);
      }
    });
  });

  it("should reject boolean period values", () => {
    const booleanValues = [true, false];

    booleanValues.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0].code).toBe("invalid_type");
        expect(result.error.issues[0].path).toEqual(["period"]);
      }
    });
  });

  it("should reject array period values", () => {
    const payload = { period: ["7d"] };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["period"]);
    }
  });

  it("should reject object period values", () => {
    const payload = { period: { value: "7d" } };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].code).toBe("invalid_type");
      expect(result.error.issues[0].path).toEqual(["period"]);
    }
  });

  it("should handle case sensitivity correctly", () => {
    const caseSensitivePeriods = ["7D", "30D", "3M", "6M", "12M"];

    caseSensitivePeriods.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0].code).toBe("invalid_enum_value");
        expect(result.error.issues[0].path).toEqual(["period"]);
      }
    });
  });

  it("should reject periods with extra whitespace", () => {
    const periodsWithWhitespace = [" 7d", "7d ", " 7d ", "7 d", "7d\n", "\t7d"];

    periodsWithWhitespace.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0].code).toBe("invalid_enum_value");
        expect(result.error.issues[0].path).toEqual(["period"]);
      }
    });
  });

  it("should handle payload with extra fields correctly", () => {
    const payload = {
      period: "7d",
      extraField: "should be ignored",
      anotherField: 123,
    };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.period).toBe("7d");

      // Extra fields should be stripped out
      expect(result.data).not.toHaveProperty("extraField");
      expect(result.data).not.toHaveProperty("anotherField");
    }
  });

  it("should provide correct error message for invalid enum values", () => {
    const payload = { period: "invalid" };
    const result = trendsPeriodSchema.safeParse(payload);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Invalid enum value. Expected '7d' | '30d' | '3m' | '6m' | '12m', received 'invalid'",
      );
    }
  });

  it("should validate all enum values are correctly defined", () => {
    // This test ensures all expected period values are defined in the schema
    const expectedPeriods = ["7d", "30d", "3m", "6m", "12m"];

    expectedPeriods.forEach((period) => {
      const payload = { period };
      const result = trendsPeriodSchema.safeParse(payload);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.period).toBe(period);
      }
    });

    // Ensure no unexpected values work
    const unexpectedPeriod = "15d";
    const invalidResult = trendsPeriodSchema.safeParse({
      period: unexpectedPeriod,
    });

    expect(invalidResult.success).toBe(false);
  });
});
