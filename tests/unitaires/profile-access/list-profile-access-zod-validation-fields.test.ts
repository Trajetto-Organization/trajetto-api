import { describe, it, expect } from "vitest";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { ZodError } from "zod";

describe("List Profile Access Zod Validation Fields", () => {
  it("should parse valid values and transform them correctly", () => {
    const input = {
      page: "3",
      pageSize: "5",
      search: "consulta",
      businessId: "business-123",
    };
    const result = listPagesByBusinessSchema.parse(input);

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(5);

    expect(result.businessId).toBe("business-123");
  });

  it("should apply fallback values when page and pageSize are falsy", () => {
    const input = {
      page: "",
      pageSize: "",
      search: undefined,
      businessId: "business-123",
    };
    const result = listPagesByBusinessSchema.parse(input);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);

    expect(result.businessId).toBe("business-123");
  });

  it("should fail when page is less than 1", () => {
    const input = { page: "-1", pageSize: "10", businessId: "business-123" };

    try {
      listPagesByBusinessSchema.parse(input);
      expect.fail("Expected parse to fail for page < 1");
    } catch (error) {
      if (error instanceof ZodError) {
        const pageError = error.errors.find((err) => err.path.includes("page"));

        expect(pageError).toBeDefined();
        expect(pageError?.message).toBe("A página é obrigatória!");
      } else {
        expect.fail("Unexpected error type");
      }
    }
  });

  it("should fail when pageSize is less than 1", () => {
    const input = { page: "10", pageSize: "-1", businessId: "business-123" };

    try {
      listPagesByBusinessSchema.parse(input);
      expect.fail("Expected parse to fail for pageSize < 1");
    } catch (error) {
      if (error instanceof ZodError) {
        const pageSizeError = error.errors.find((err) =>
          err.path.includes("pageSize"),
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

  it("should succeed when search field is omitted", () => {
    const input = { page: "2", pageSize: "3", businessId: "business-123" };
    const result = listPagesByBusinessSchema.parse(input);

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(3);

    expect(result.businessId).toBe("business-123");
  });
});
