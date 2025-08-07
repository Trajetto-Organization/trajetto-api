import { describe, it, expect } from "vitest";
import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

describe("Update/Delete User Zod Validation Fields", () => {
  it("should pass when profileAccessId is provided", () => {
    const result = updateDeleteUserSchema.safeParse({
      userId: "123",
    });

    expect(result.success).toBe(true);
  });

  it("should fail when profileAccessId is empty", () => {
    const result = updateDeleteUserSchema.safeParse({
      userId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().userId?._errors).toContain(
      "O ID do usuário é obrigatório!",
    );
  });
});
