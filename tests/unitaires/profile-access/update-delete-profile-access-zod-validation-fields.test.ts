import { describe, it, expect } from "vitest";
import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";

describe("Update/Delete Profile Access Zod Validation Fields", () => {
  it("should pass when profileAccessId is provided", () => {
    const result = updateDeleteProfileAccessSchema.safeParse({
      profileAccessId: "550e8400-e29b-41d4-a716-446655440001",
    });

    expect(result.success).toBe(true);
  });

  it("should fail when profileAccessId is empty", () => {
    const result = updateDeleteProfileAccessSchema.safeParse({
      profileAccessId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().profileAccessId?._errors).toContain(
      "ID do perfil de acesso é inválido.",
    );
  });
});
