import { describe, it, expect } from "vitest";
import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";

describe("Update User Password Zod Validation Fields", () => {
  it("should validate a valid current and new password", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "ValidPass123",
      newPassword: "NewValidPass456",
    });

    expect(result.success).toBe(true);
  });

  it("should fail if current password is empty", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "NewValidPass456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().currentPassword?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if new password is empty", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "ValidPass123",
      newPassword: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().newPassword?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if current password is shorter than 7 characters", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "123456",
      newPassword: "NewValidPass456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().currentPassword?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if new password is shorter than 7 characters", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "ValidPass123",
      newPassword: "123456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().newPassword?._errors).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("should fail if current password exceeds 100 characters", () => {
    const longPassword = "a".repeat(101);
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: longPassword,
      newPassword: "NewValidPass456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().currentPassword?._errors).toContain(
      "A senha deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if new password exceeds 100 characters", () => {
    const longPassword = "a".repeat(101);
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "ValidPass123",
      newPassword: longPassword,
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().newPassword?._errors).toContain(
      "A senha deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if current password contains spaces", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "Password With Space",
      newPassword: "NewValidPass456",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().currentPassword?._errors).toContain(
      "A senha não deve conter espaços.",
    );
  });

  it("should fail if new password contains spaces", () => {
    const result = updateUserPasswordSchema.safeParse({
      currentPassword: "ValidPass123",
      newPassword: "New Password With Space",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().newPassword?._errors).toContain(
      "A senha não deve conter espaços.",
    );
  });
});
