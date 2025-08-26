import { describe, it, expect } from "vitest";

import { createUserSchema } from "@/schemas/create-user-schema";
import { UserBusinessRole } from "@/modules/user/dtos/user-dto";

describe("Create User Zod Validation Fields", () => {
  it("should validate a valid payload for a non-BUSINESS_ADMIN user", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid payload for a BUSINESS_ADMIN user without profileAccessId", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_ADMIN,
      businessId: "123",
      // profileAccessId is optional for BUSINESS_ADMIN
    };

    const result = createUserSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the email is empty", () => {
    const payload = {
      email: "",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail é obrigatório.",
    );
  });

  it("should fail if the email is invalid", () => {
    const payload = {
      email: "invalid-email",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail informado não é válido.",
    );
  });

  it("should fail if the email exceeds 100 characters", () => {
    const payload = {
      email: "a".repeat(95) + "@ex.com", // total > 100 characters
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if the name exceeds 100 characters", () => {
    const payload = {
      email: "valid@example.com",
      name: "a".repeat(101),
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome de usuário não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the name contains consecutive spaces", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full  Name", // two consecutive spaces
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome de usuário não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the name is incomplete (only one word)", () => {
    const payload = {
      email: "valid@example.com",
      name: "Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "Por favor, insira o nome de usuário completo.",
    );
  });

  it("should fail if the password has less than 7 characters", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "123456", // 6 characters
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().password?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if the password exceeds 100 characters", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "a".repeat(101),
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().password?._errors).toContain(
      "A senha deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if the password contains spaces", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "password with spaces",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().password?._errors).toContain(
      "A senha não deve conter espaços.",
    );
  });

  it("should fail if the role is invalid", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "validPass1",
      role: "INVALID_ROLE", // invalid role
      businessId: "123",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);
    expect(result.success).toBe(false);

    const validValues = Object.values(UserBusinessRole).join(", ");
    expect(result.error?.format().role?._errors).toContain(
      `Nível de acesso do usuário inválido. Valores válidos: ${validValues}`,
    );
  });

  it("should fail if the businessId is empty", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "",
      profileAccessId: "profile-456",
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "A empresa é obrigatória!",
    );
  });

  it("should fail if profileAccessId is empty for a non-BUSINESS_ADMIN user", () => {
    const payload = {
      email: "valid@example.com",
      name: "Full Name",
      password: "validPass1",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "  ", // only spaces
    };

    const result = createUserSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().profileAccessId?._errors).toContain(
      "O Perfil de acesso é obrigatório!",
    );
  });
});
