import { describe, it, expect } from "vitest";
import { updateDeleteDriverSchema } from "../../../src/schemas/update-delete-driver-schema";

describe("Update Delete Driver Schema Validation", () => {
  describe("driverId field validation", () => {
    it("should accept valid UUID", () => {
      const data = { driverId: "123e4567-e89b-12d3-a456-426614174000" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject invalid UUID", () => {
      const data = { driverId: "invalid-uuid" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });

    it("should reject empty string", () => {
      const data = { driverId: "" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });

    it("should reject non-string value", () => {
      const data = { driverId: 123 };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it("should reject missing driverId field", () => {
      const data = {};
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it("should accept lowercase UUID", () => {
      const data = { driverId: "123e4567-e89b-12d3-a456-426614174000" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept uppercase UUID", () => {
      const data = { driverId: "123E4567-E89B-12D3-A456-426614174000" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject UUID without hyphens", () => {
      const data = { driverId: "123e4567e89b12d3a456426614174000" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });

    it("should reject UUID with wrong format", () => {
      const data = { driverId: "123e4567-e89b-12d3-a456-42661417400" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });

    it("should reject UUID with extra characters", () => {
      const data = { driverId: "123e4567-e89b-12d3-a456-426614174000-extra" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });

    it("should reject special characters in UUID", () => {
      const data = { driverId: "123e4567@e89b-12d3-a456-426614174000" };
      const result = updateDeleteDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "ID do motorista é inválido.",
      );
    });
  });
});
