import { describe, it, expect } from "vitest";

import { EnumPermissionKey } from "@/config/permissions";
import { updatePermissionSchema } from "@/schemas/update-permission-schema";

describe("Update Permission Zod Validation Fields", () => {
  it("should pass when all fields are valid", () => {
    const validData = {
      action: "Valid Action",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("should fail when action is empty or contains only spaces", () => {
    const invalidData = {
      action: "   ",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should fail when action exceeds 100 characters", () => {
    const longAction = "a".repeat(101);
    const invalidData = {
      action: longAction,
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não deve exceder 100 caracteres.",
    );
  });

  it("should fail when action contains consecutive spaces", () => {
    const invalidData = {
      action: "Invalid  Action",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não deve conter espaços consecutivos.",
    );
  });

  it("should fail when action starts or ends with a space", () => {
    const invalidData = {
      action: " Action with space ",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail when businessId is not provided", () => {
    const invalidData = {
      action: "Valid Action",
      canRead: true,
      canWrite: false,
      businessId: "",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "A empresa é obrigatória!",
    );
  });

  it("should fail when profileAccessId is not provided", () => {
    const invalidData = {
      action: "Valid Action",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    expect(result.error?.format().profileAccessId?._errors).toContain(
      "O Perfil de acesso é obrigatório!",
    );
  });

  it("should fail when canRead is not selected", () => {
    const invalidData = {
      action: "Valid Action",
      canRead: false,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    expect(result.error?.format().canRead?._errors).toContain(
      "Selecione a opção Leitura (caso deseje, marque também Escrita).",
    );
  });

  it("should pass when canRead is selected", () => {
    const validData = {
      action: "Valid Action",
      canRead: true,
      canWrite: true,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = updatePermissionSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("should fail when permissionKey is invalid", () => {
    const invalidData = {
      action: "Valid Action",
      canRead: true,
      canWrite: false,
      businessId: "1",
      profileAccessId: "1",
      permissionKey: "invalid_permission_key",
    };

    const result = updatePermissionSchema.safeParse(invalidData);

    expect(result.success).toBe(false);
    const errorMessage =
      result.error?.format().permissionKey?._errors?.[0] || "";
    expect(errorMessage).toContain(
      "A permissão informada não é válida. Valores válidos:",
    );
    expect(errorMessage).toContain("branch_manage");
    expect(errorMessage).toContain("profile_access_manage");
    expect(errorMessage).toContain("user_permission_manage");
  });
});
