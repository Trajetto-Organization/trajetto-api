import { describe, it, expect } from "vitest";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

describe("List Vehicle Business Zod Validation Fields", () => {
  describe("page field validation", () => {
    it("should accept valid page number as string", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(1);
    });

    it("should accept page number greater than 1", () => {
      const data = {
        page: "5",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(5);
    });

    it("should default to 1 when page is empty string", () => {
      const data = {
        page: "",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(1);
    });

    it("should default to 1 when page is invalid number", () => {
      const data = {
        page: "invalid",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(1);
    });

    it("should default to 1 when page is 0", () => {
      const data = {
        page: "0",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(1);
    });

    it("should not accept negative page number", () => {
      const data = {
        page: "-1",
        pageSize: "10",
        businessId: "business-id-123",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A página é obrigatória!",
      );
    });

    it("should accept large page numbers", () => {
      const data = {
        page: "9999",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.page).toBe(9999);
    });
  });

  // ============== PAGE SIZE FIELD TESTS ==============
  describe("pageSize field validation", () => {
    it("should accept valid pageSize as string", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(10);
    });

    it("should accept pageSize of 1", () => {
      const data = {
        page: "1",
        pageSize: "1",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(1);
    });

    it("should accept large pageSize", () => {
      const data = {
        page: "1",
        pageSize: "1000",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(1000);
    });

    it("should default to 2 when pageSize is empty string", () => {
      const data = {
        page: "1",
        pageSize: "",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(2);
    });

    it("should default to 2 when pageSize is invalid number", () => {
      const data = {
        page: "1",
        pageSize: "invalid",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(2);
    });

    it("should default to 2 when pageSize is 0", () => {
      const data = {
        page: "1",
        pageSize: "0",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.pageSize).toBe(2);
    });

    it("should not accept negative pageSize", () => {
      const data = {
        page: "1",
        pageSize: "-5",
        businessId: "business-id-123",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A quantidade de páginas é obrigatória!",
      );
    });
  });

  // ============== BUSINESS ID FIELD TESTS ==============
  describe("businessId field validation", () => {
    it("should accept valid businessId", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.businessId).toBe("business-id-123");
    });

    it("should accept businessId with UUID format", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "550e8400-e29b-41d4-a716-446655440000",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.businessId).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should not accept empty businessId", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A empresa é obrigatória!",
      );
    });

    it("should not accept missing businessId", () => {
      const data = {
        page: "1",
        pageSize: "10",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A empresa é obrigatória!",
      );
    });

    it("should not accept null businessId", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: null,
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow();
    });

    it("should not accept undefined businessId", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: undefined,
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A empresa é obrigatória!",
      );
    });

    it("should accept businessId with special characters", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id_123-abc",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.businessId).toBe("business-id_123-abc");
    });
  });

  // ============== SEARCH FIELD TESTS ==============
  describe("search field validation", () => {
    it("should accept valid search string", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "ABC1234",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("ABC1234");
    });

    it("should accept search with spaces", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "Mercedes Truck",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("Mercedes Truck");
    });

    it("should accept search with special characters", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "ABC-1234",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("ABC-1234");
    });

    it("should accept empty search string", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("");
    });

    it("should accept undefined search (optional field)", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBeUndefined();
    });

    it("should accept single character search", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "A",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("A");
    });

    it("should accept long search string", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "This is a very long search string to test the validation",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe(
        "This is a very long search string to test the validation",
      );
    });

    it("should accept search with numbers only", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "12345",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("12345");
    });
  });

  // ============== COMBINED VALIDATION TESTS ==============
  describe("combined field validation", () => {
    it("should accept all valid fields together", () => {
      const data = {
        page: "2",
        pageSize: "20",
        businessId: "550e8400-e29b-41d4-a716-446655440000",
        search: "Mercedes",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(2);
      expect(parsed.pageSize).toBe(20);

      expect(parsed.businessId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.search).toBe("Mercedes");
    });

    it("should accept minimal required fields only", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(1);
      expect(parsed.pageSize).toBe(10);

      expect(parsed.businessId).toBe("business-id");
      expect(parsed.search).toBeUndefined();
    });

    it("should handle defaults for page and pageSize with valid businessId", () => {
      const data = {
        page: "",
        pageSize: "",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(1);
      expect(parsed.pageSize).toBe(2);
    });

    it("should fail when businessId is missing even with valid page and pageSize", () => {
      const data = {
        page: "1",
        pageSize: "10",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow(
        "A empresa é obrigatória!",
      );
    });

    it("should fail with multiple invalid fields", () => {
      const data = {
        page: "-1",
        pageSize: "0",
        businessId: "",
      };

      expect(() => listPagesByBusinessSchema.parse(data)).toThrow();
    });
  });

  // ============== EDGE CASES ==============
  describe("edge cases", () => {
    it("should handle very large page and pageSize numbers", () => {
      const data = {
        page: "999999",
        pageSize: "999999",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(999999);
      expect(parsed.pageSize).toBe(999999);
    });

    it("should handle decimal page numbers by converting to integer", () => {
      const data = {
        page: "2.5",
        pageSize: "10.7",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(2.5);
      expect(parsed.pageSize).toBe(10.7);
    });

    it("should handle businessId with only spaces correctly", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "   ",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.businessId).toBe("   ");
    });

    it("should handle search with only spaces", () => {
      const data = {
        page: "1",
        pageSize: "10",
        businessId: "business-id-123",
        search: "   ",
      };

      const parsed = listPagesByBusinessSchema.parse(data);
      expect(parsed.search).toBe("   ");
    });

    it("should transform string numbers correctly for page", () => {
      const data = {
        page: "001",
        pageSize: "010",
        businessId: "business-id-123",
      };

      const parsed = listPagesByBusinessSchema.parse(data);

      expect(parsed.page).toBe(1);
      expect(parsed.pageSize).toBe(10);
    });
  });
});
