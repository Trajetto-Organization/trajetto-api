import { describe, it, expect } from "vitest";
import { createProfileAccessSchema } from "@/schemas/create-profile-access";

describe("Create Profile Access Zod Validation Fields", () => {
  it("should validate a valid payload", () => {
    const payload = {
      name: "Valid Profile Name",
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the name has less than 3 characters", () => {
    const payload = {
      name: "ab",
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the name is only whitespace", () => {
    const payload = {
      name: "    ",
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should fail if the name exceeds 100 characters", () => {
    const payload = {
      name: "a".repeat(101),
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the name contains consecutive spaces", () => {
    const payload = {
      name: "Valid  Profile", // two consecutive spaces
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the name starts with whitespace", () => {
    const payload = {
      name: " LeadingSpace",
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the name ends with whitespace", () => {
    const payload = {
      name: "TrailingSpace ",
      businessId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the businessId is empty", () => {
    const payload = {
      name: "Valid Profile Name",
      businessId: "",
    };

    const result = createProfileAccessSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "ID da empresa é inválido.",
    );
  });
});
