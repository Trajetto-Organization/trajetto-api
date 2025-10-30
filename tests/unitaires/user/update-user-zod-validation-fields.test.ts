import { describe, it, expect } from "vitest";

import { updateUserSchema } from "@/schemas/update-user-schema";
import { UserBusinessRole } from "@/modules/user/dtos/user-dto";

describe("Update User Zod Validation Fields", () => {
  it("should validate a valid user update payload", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(true);
  });

  it("should allow optional fields to be empty", () => {
    const result = updateUserSchema.safeParse({
      email: "",
      name: "",
      password: "",
      role: null,
      businessId: "123",
      profileAccessId: "",
    });

    expect(result.success).toBe(true);
  });

  it("should fail if email is invalid", () => {
    const result = updateUserSchema.safeParse({
      email: "invalid-email",
      name: "John Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail informado não é válido.",
    );
  });

  it("should fail if name exceeds 100 characters", () => {
    const longName = "a".repeat(101);
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: longName,
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome de usuário não deve exceder 100 caracteres.",
    );
  });

  it("should fail if name contains consecutive spaces", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John  Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome de usuário não deve conter espaços consecutivos.",
    );
  });

  it("should fail if name is not complete", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "Por favor, insira o nome de usuário completo.",
    );
  });

  it("should fail if password is shorter than 7 characters", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "123456",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().password?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if password exceeds 100 characters", () => {
    const longPassword = "a".repeat(101);
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: longPassword,
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().password?._errors).toContain(
      "A senha deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if role is invalid", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "validPass123",
      role: "INVALID_ROLE",
      businessId: "123",
      profileAccessId: "profile-456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().role?._errors[0]).toContain(
      "Nível de acesso do usuário inválido.",
    );
  });

  it("should fail if profileAccessId is empty when role is not BUSINESS_ADMIN", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_USER,
      businessId: "123",
      profileAccessId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().profileAccessId?._errors).toContain(
      "Selecione um perfil de acesso!",
    );
  });

  it("should pass if profileAccessId is empty when role is BUSINESS_ADMIN", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_ADMIN,
      businessId: "123",
      profileAccessId: "",
    });

    expect(result.success).toBe(true);
  });

  it("should fail if businessId is missing", () => {
    const result = updateUserSchema.safeParse({
      email: "valid@example.com",
      name: "John Doe",
      password: "validPass123",
      role: UserBusinessRole.BUSINESS_ADMIN,
      profileAccessId: "",
      businessId: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "A empresa é obrigatória!",
    );
  });
});
