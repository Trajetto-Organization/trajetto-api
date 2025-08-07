import { describe, it, expect } from "vitest";
import { listProfileAccessSchema } from "@/schemas/list-profile-access-schema";

import { ZodError } from "zod";

describe("List Profile Access Zod Validation Fields", () => {
  it("should parse valid values and transform them correctly", () => {
    const input = { page: "3", pageSize: "5", search: "consulta" };
    const result = listProfileAccessSchema.parse(input);

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(5);

    expect(result.search).toBe("consulta");
  });

  it("should apply fallback values when page and pageSize are falsy", () => {
    const input = { page: "", pageSize: "", search: undefined };
    const result = listProfileAccessSchema.parse(input);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);

    expect(result.search).toBeUndefined();
  });

  it("should fail when page is less than 1", () => {
    const input = { page: "-1", pageSize: "10" };

    try {
      listProfileAccessSchema.parse(input);
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
    const input = { page: "10", pageSize: "-1" };

    try {
      listProfileAccessSchema.parse(input);
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
    const input = { page: "2", pageSize: "3" };
    const result = listProfileAccessSchema.parse(input);

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(3);

    expect(result.search).toBeUndefined();
  });
});
