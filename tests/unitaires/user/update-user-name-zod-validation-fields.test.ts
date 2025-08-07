import { describe, it, expect } from "vitest";
import { updateUserNameSchema } from "@/schemas/update-user-name-schema";

describe("Update User Name Zod Validation Fields", () => {
  it("should validate a valid full name", () => {
    const result = updateUserNameSchema.safeParse({
      name: "John Doe",
    });

    expect(result.success).toBe(true);
  });

  it("should fail if name is empty", () => {
    const result = updateUserNameSchema.safeParse({
      name: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "Por favor, insira o nome completo.",
    );
  });

  it("should fail if name exceeds 100 characters", () => {
    const longName = "A".repeat(101);
    const result = updateUserNameSchema.safeParse({
      name: longName,
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should fail if name contains consecutive spaces", () => {
    const result = updateUserNameSchema.safeParse({
      name: "John  Doe",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should fail if name does not contain at least a first and last name", () => {
    const result = updateUserNameSchema.safeParse({
      name: "John",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "Por favor, insira o nome completo.",
    );
  });

  it("should validate a name exactly 100 characters long", () => {
    const validLongName = "A".repeat(49) + " " + "B".repeat(49);
    const result = updateUserNameSchema.safeParse({
      name: validLongName,
    });

    expect(result.success).toBe(true);
  });

  it("should fail if name contains only spaces", () => {
    const result = updateUserNameSchema.safeParse({
      name: "    ",
    });

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });
});
