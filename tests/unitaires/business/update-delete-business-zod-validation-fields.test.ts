import { describe, it, expect } from "vitest";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

describe("Update/Delete Business Zod Validation Fields", () => {
  it("should pass when businessId is provided", () => {
    const result = updateDeleteBusinessSchema.safeParse({
      businessId: "123",
    });

    expect(result.success).toBe(true);
  });

  it("should fail when businessId is empty", () => {
    const result = updateDeleteBusinessSchema.safeParse({
      businessId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "O ID da empresa é obrigatório!",
    );
  });
});
