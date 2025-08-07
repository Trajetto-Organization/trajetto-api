import { describe, it, expect } from "vitest";

import { listProfileBusinessAccessSchema } from "@/schemas/list-profile-business-schema";
import { ZodError } from "zod";

describe("listProfileBusinessAccessSchema", () => {
  it("should parse valid input correctly", () => {
    const input = { page: "3", pageSize: "10", businessId: "company" };
    const result = listProfileBusinessAccessSchema.parse(input);

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);

    expect(result.businessId).toBe("company");
  });

  it("should fallback to default values for page and pageSize when empty strings are provided", () => {
    const input = { page: "", pageSize: "", businessId: "company" };
    const result = listProfileBusinessAccessSchema.parse(input);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);

    expect(result.businessId).toBe("company");
  });

  it("should fail when page is less than 1", () => {
    const input = { page: "-1", pageSize: "5", businessId: "company" };

    try {
      listProfileBusinessAccessSchema.parse(input);
      expect.fail("Expected validation to fail for page < 1");
    } catch (error) {
      if (error instanceof ZodError) {
        const pageError = error.errors.find((e) => e.path.includes("page"));

        expect(pageError).toBeDefined();
        expect(pageError?.message).toBe("A página é obrigatória!");
      } else {
        expect.fail("Unexpected error type");
      }
    }
  });

  it("should fail when pageSize is less than 1", () => {
    const input = { page: "5", pageSize: "-1", businessId: "company" };

    try {
      listProfileBusinessAccessSchema.parse(input);
      expect.fail("Expected validation to fail for pageSize < 1");
    } catch (error) {
      if (error instanceof ZodError) {
        const pageSizeError = error.errors.find((e) =>
          e.path.includes("pageSize"),
        );

        expect(pageSizeError).toBeDefined();
        expect(pageSizeError?.message).toBe(
          "A quantidade de páginas é obrigatória!",
        );
      } else {
        expect.fail("Unexpected error type");
      }
    }
  });

  it("should fail when businessId is an empty string", () => {
    const input = { page: "5", pageSize: "10", businessId: "" };

    try {
      listProfileBusinessAccessSchema.parse(input);
      expect.fail("Expected validation to fail for empty businessId");
    } catch (error) {
      if (error instanceof ZodError) {
        const businessIdError = error.errors.find((e) =>
          e.path.includes("businessId"),
        );

        expect(businessIdError).toBeDefined();
        expect(businessIdError?.message).toBe("A empresa é obrigatória!");
      } else {
        expect.fail("Unexpected error type");
      }
    }
  });

  it("should fail when businessId is missing", () => {
    const input = { page: "5", pageSize: "10" };

    try {
      listProfileBusinessAccessSchema.parse(input);
      expect.fail("Expected validation to fail for missing businessId");
    } catch (error) {
      if (error instanceof ZodError) {
        const businessIdError = error.errors.find((e) =>
          e.path.includes("businessId"),
        );

        expect(businessIdError).toBeDefined();
        expect(businessIdError?.message.toLowerCase()).toContain("empresa");
      } else {
        expect.fail("Unexpected error type");
      }
    }
  });
});
