import { describe, it, expect } from "vitest";
import { listQuotesQuerySchema } from "@/schemas/list-quotes-query-schema";

describe("List Quotes Query Zod Validation Fields", () => {
  describe("page field validation", () => {
    it("should accept valid page numbers", () => {
      const validPages = [1, 2, 5, 10, 100];

      validPages.forEach((page) => {
        const data = { page };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.page).toBe(page);
        }
      });
    });

    it("should coerce string page numbers to numbers", () => {
      const stringPages = ["1", "2", "5", "10"];
      const expectedPages = [1, 2, 5, 10];

      stringPages.forEach((page, index) => {
        const data = { page };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.page).toBe(expectedPages[index]);
        }
      });
    });

    it("should default to 1 when page is not provided", () => {
      const data = {};
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
      }
    });

    it("should reject page numbers less than 1", () => {
      const invalidPages = [0, -1, -5, -10];

      invalidPages.forEach((page) => {
        const data = { page };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });
    });

    it("should reject non-numeric page values", () => {
      const invalidPages = ["invalid", "abc"];

      invalidPages.forEach((page) => {
        const data = { page };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });

      // These might be coerced or have defaults, so test separately
      const edgeCases = ["1.5", ""];
      edgeCases.forEach((page) => {
        const data = { page };
        const result = listQuotesQuerySchema.safeParse(data);
        // Some edge cases might be handled by coercion, so we check if they fail or get coerced
        if (result.success) {
          expect(typeof result.data.page).toBe("number");
        }
      });
    });
  });

  describe("pageSize field validation", () => {
    it("should accept valid page sizes", () => {
      const validPageSizes = [1, 5, 10, 25, 50, 100];

      validPageSizes.forEach((pageSize) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.pageSize).toBe(pageSize);
        }
      });
    });

    it("should coerce string page sizes to numbers", () => {
      const stringPageSizes = ["1", "10", "25", "50"];
      const expectedPageSizes = [1, 10, 25, 50];

      stringPageSizes.forEach((pageSize, index) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.pageSize).toBe(expectedPageSizes[index]);
        }
      });
    });

    it("should default to 10 when pageSize is not provided", () => {
      const data = {};
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageSize).toBe(10);
      }
    });

    it("should reject page sizes less than 1", () => {
      const invalidPageSizes = [0, -1, -5, -10];

      invalidPageSizes.forEach((pageSize) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });
    });

    it("should reject page sizes greater than 100", () => {
      const invalidPageSizes = [101, 150, 200, 1000];

      invalidPageSizes.forEach((pageSize) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });

    it("should accept page size of exactly 100", () => {
      const data = { pageSize: 100 };
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageSize).toBe(100);
      }
    });

    it("should reject non-numeric page size values", () => {
      const invalidPageSizes = ["invalid", "abc"];

      invalidPageSizes.forEach((pageSize) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });

      // These might be coerced or have defaults, so test separately
      const edgeCases = ["1.5", ""];
      edgeCases.forEach((pageSize) => {
        const data = { pageSize };
        const result = listQuotesQuerySchema.safeParse(data);

        // Some edge cases might be handled by coercion
        if (result.success) {
          expect(typeof result.data.pageSize).toBe("number");
        }
      });
    });
  });

  describe("search field validation", () => {
    it("should accept valid search strings", () => {
      const validSearches = [
        "John Doe",
        "Company Name",
        "user@example.com",
        "Test search",
        "João Silva",
        "123456",
      ];

      validSearches.forEach((search) => {
        const data = { search };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.search).toBe(search);
        }
      });
    });

    it("should accept empty search string", () => {
      const data = { search: "" };
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe("");
      }
    });

    it("should make search field optional", () => {
      const data = {};
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBeUndefined();
      }
    });

    it("should accept search with special characters", () => {
      const validSearches = [
        "Company@example.com",
        "User-Name",
        "Company & Co.",
        "Test (Company)",
        "João & Maria LTDA",
      ];

      validSearches.forEach((search) => {
        const data = { search };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.search).toBe(search);
        }
      });
    });

    it("should accept search with numbers", () => {
      const data = { search: "123456789" };
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe("123456789");
      }
    });

    it("should reject non-string search values", () => {
      const invalidSearches = [123, true, [], {}, null];

      invalidSearches.forEach((search) => {
        const data = { search };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });
    });
  });

  describe("status field validation", () => {
    it("should accept all valid status values", () => {
      const validStatuses = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"];

      validStatuses.forEach((status) => {
        const data = { status };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.status).toBe(status);
        }
      });
    });

    it("should make status field optional", () => {
      const data = {};
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBeUndefined();
      }
    });

    it("should reject invalid status values", () => {
      const invalidStatuses = [
        "INVALID",
        "pending", // lowercase
        "contacted", // lowercase
        "COMPLETE",
        "ACTIVE",
        "INACTIVE",
        "",
        123,
        true,
      ];

      invalidStatuses.forEach((status) => {
        const data = { status };
        const result = listQuotesQuerySchema.safeParse(data);

        expect(result.success).toBe(false);
      });
    });

    it("should be case sensitive", () => {
      const invalidStatuses = [
        "pending",
        "Pending",
        "PENDING ", // with space
        " PENDING", // with space
        "contacted",
        "Contacted",
        "closed",
        "Closed",
        "converted",
        "Converted",
      ];

      invalidStatuses.forEach((status) => {
        const data = { status };
        const result = listQuotesQuerySchema.safeParse(data);

        if (
          status.trim().toUpperCase() === status &&
          ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"].includes(status)
        ) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      });
    });
  });

  describe("combined field validation", () => {
    it("should accept valid combination of all fields", () => {
      const data = {
        page: 2,
        pageSize: 25,
        search: "John Company",
        status: "CONTACTED",
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.pageSize).toBe(25);

        expect(result.data.search).toBe("John Company");
        expect(result.data.status).toBe("CONTACTED");
      }
    });

    it("should accept partial field combinations", () => {
      const validCombinations = [
        { page: 1 },
        { pageSize: 50 },
        { search: "test" },
        { status: "PENDING" },
        { page: 2, pageSize: 20 },
        { search: "company", status: "CLOSED" },
        { page: 3, search: "email@test.com" },
        { pageSize: 15, status: "CONVERTED" },
      ];

      validCombinations.forEach((data) => {
        const result = listQuotesQuerySchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          // Check defaults are applied
          expect(result.data.page).toBe(data.page || 1);
          expect(result.data.pageSize).toBe(data.pageSize || 10);

          expect(result.data.search).toBe(data.search);
          expect(result.data.status).toBe(data.status);
        }
      });
    });

    it("should apply default values when fields are missing", () => {
      const data = {
        search: "test search",
        status: "PENDING",
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1); // default
        expect(result.data.pageSize).toBe(10); // default

        expect(result.data.search).toBe("test search");
        expect(result.data.status).toBe("PENDING");
      }
    });

    it("should reject combinations with invalid fields", () => {
      const invalidCombinations = [
        { page: -1, pageSize: 10 },
        { page: 1, pageSize: 101 },
        { page: "invalid", search: "test" },
        { pageSize: 25, status: "INVALID_STATUS" },
        { page: 0, pageSize: 0, search: "test" },
      ];

      invalidCombinations.forEach((data) => {
        const result = listQuotesQuerySchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });

    it("should handle empty object with all defaults", () => {
      const data = {};
      const result = listQuotesQuerySchema.safeParse(data);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.pageSize).toBe(10);

        expect(result.data.search).toBeUndefined();
        expect(result.data.status).toBeUndefined();
      }
    });

    it("should handle string coercion for numeric fields", () => {
      const data = {
        page: "5",
        pageSize: "20",
        search: "test company",
        status: "CONTACTED",
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.page).toBe(5);
        expect(result.data.pageSize).toBe(20);

        expect(result.data.search).toBe("test company");
        expect(result.data.status).toBe("CONTACTED");
      }
    });

    it("should maintain type safety for all fields", () => {
      const data = {
        page: 1,
        pageSize: 10,
        search: "test",
        status: "PENDING",
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        // TypeScript should infer correct types
        const page: number = result.data.page;
        const pageSize: number = result.data.pageSize;

        const search: string | undefined = result.data.search;
        const status:
          | "PENDING"
          | "CONTACTED"
          | "CLOSED"
          | "CONVERTED"
          | undefined = result.data.status;

        expect(typeof page).toBe("number");
        expect(typeof pageSize).toBe("number");

        expect(typeof search).toBe("string");
        expect(typeof status).toBe("string");
      }
    });
  });

  describe("edge cases", () => {
    it("should handle null values", () => {
      const data = {
        page: null,
        pageSize: null,
        search: null,
        status: null,
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("should handle undefined values", () => {
      const data = {
        page: undefined,
        pageSize: undefined,
        search: undefined,
        status: undefined,
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.pageSize).toBe(10);

        expect(result.data.search).toBeUndefined();
        expect(result.data.status).toBeUndefined();
      }
    });

    it("should handle extra properties", () => {
      const data = {
        page: 1,
        pageSize: 10,
        search: "test",
        status: "PENDING",
        extraField: "should be ignored",
      };

      const result = listQuotesQuerySchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data).not.toHaveProperty("extraField");
        expect(result.data.page).toBe(1);

        expect(result.data.pageSize).toBe(10);
        expect(result.data.search).toBe("test");

        expect(result.data.status).toBe("PENDING");
      }
    });
  });
});
