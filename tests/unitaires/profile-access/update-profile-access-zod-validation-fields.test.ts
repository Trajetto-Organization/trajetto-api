import { describe, it, expect } from "vitest";
import { updateProfileAccessSchema } from "@/schemas/update-profile-access";

describe("Update Profile Access Zod Validation Fields", () => {
  it("should pass when the name is valid and businessId is provided", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "Valid Access Profile",
      businessId: "1",
    });

    expect(result.success).toBe(true);
  });

  it("should fail when the name is less than 3 characters", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "Jo",
      businessId: "1",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil deve ter no mínimo 3 caracteres.",
    );
  });

  it("should convert whitespace-only name to null", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "   ",
      businessId: "1",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeNull();
    }
  });

  it("should fail when the name exceeds 100 characters", () => {
    const longName = "a".repeat(101);
    const result = updateProfileAccessSchema.safeParse({
      name: longName,
      businessId: "1",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não deve exceder 100 caracteres.",
    );
  });

  it("should fail when the name contains consecutive spaces", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "Name  with spaces",
      businessId: "1",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não deve conter espaços consecutivos.",
    );
  });

  it("should fail when the name starts or ends with a space", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: " Name with space at the beginning",
      businessId: "1",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do perfil de acesso não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail when businessId is not provided", async () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "Valid Name",
      businessId: "",
    });

    expect(result.success).toBe(false);

    const errorMessages = result.error?.format();
    expect(errorMessages?.businessId?._errors).toContain(
      "A empresa é obrigatória!",
    );
  });

  it("should pass when the name is empty (empty string) and businessId is valid", () => {
    const result = updateProfileAccessSchema.safeParse({
      name: "",
      businessId: "1",
    });

    expect(result.success).toBe(true);
  });
});
