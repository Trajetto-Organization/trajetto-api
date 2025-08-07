import { describe, it, expect } from "vitest";
import { createPermissionSchema } from "@/schemas/create-permission-schema";

import { EnumPermissionKey } from "@/config/permissions";

describe("Create Permission Zod validation Fields", () => {
  it("should validate a valid payload", () => {
    const payload = {
      action: "Valid Action",
      canRead: true,
      // canWrite is optional; defaults to false if not provided
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should default canWrite to false if not provided", () => {
    const payload = {
      action: "Valid Action",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.canWrite).toBe(false);
    }
  });

  it("should fail if action has less than 3 characters", () => {
    const payload = {
      action: "ab",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if action is only whitespace", () => {
    const payload = {
      action: "    ",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should fail if action exceeds 100 characters", () => {
    const payload = {
      action: "a".repeat(101),
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não deve exceder 100 caracteres.",
    );
  });

  it("should fail if action contains consecutive spaces", () => {
    const payload = {
      action: "Valid  Action", // two consecutive spaces
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não deve conter espaços consecutivos.",
    );
  });

  it("should fail if action starts with whitespace", () => {
    const payload = {
      action: " LeadingAction",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if action ends with whitespace", () => {
    const payload = {
      action: "TrailingAction ",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().action?._errors).toContain(
      "O nome da permissão não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if businessId is empty", () => {
    const payload = {
      action: "Valid Action",
      canRead: true,
      businessId: "",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "A empresa é obrigatória!",
    );
  });

  it("should fail if profileAccessId is empty", () => {
    const payload = {
      action: "Valid Action",
      canRead: true,
      businessId: "123",
      profileAccessId: "",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().profileAccessId?._errors).toContain(
      "O Perfil de acesso é obrigatório!",
    );
  });

  it("should fail if permissionKey is invalid", () => {
    const payload = {
      action: "Valid Action",
      canRead: true,
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: "invalid_permission", // not a valid enum value
    };

    const result = createPermissionSchema.safeParse(payload);
    expect(result.success).toBe(false);

    const validValues = Object.values(EnumPermissionKey).join(", ");
    expect(result.error?.format().permissionKey?._errors).toContain(
      `A permissão informada não é válida. Valores válidos: ${validValues}`,
    );
  });

  it("should fail if canRead is false", () => {
    const payload = {
      action: "Valid Action",
      canRead: false, // refine rule: canRead must be true
      businessId: "123",
      profileAccessId: "profile-456",
      permissionKey: EnumPermissionKey.PROFILE_ACCESS_MANAGE,
    };

    const result = createPermissionSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().canRead?._errors).toContain(
      "Selecione a opção Leitura (caso deseje, marque também Escrita).",
    );
  });
});
