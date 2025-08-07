import { describe, it, expect } from "vitest";
import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";

describe("Update/Delete Permission Zod Validation Fields", () => {
  it("should pass when permissionId is provided", () => {
    const result = updateDeletePermissionSchema.safeParse({
      permissionId: "123",
    });

    expect(result.success).toBe(true);
  });

  it("should fail when permissionId is empty", () => {
    const result = updateDeletePermissionSchema.safeParse({
      permissionId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().permissionId?._errors).toContain(
      "O ID da permissão é obrigatória!",
    );
  });
});
