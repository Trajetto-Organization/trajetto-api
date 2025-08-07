import { z } from "zod";

const updateUserPasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(7, "A senha deve ter pelo menos 7 caracteres.")
    .max(100, "A senha deve ter no máximo 100 caracteres.")
    .refine((value) => !/\s/.test(value), {
      message: "A senha não deve conter espaços.",
    }),
  newPassword: z
    .string()
    .min(7, "A senha deve ter pelo menos 7 caracteres.")
    .max(100, "A senha deve ter no máximo 100 caracteres.")
    .refine((value) => !/\s/.test(value), {
      message: "A senha não deve conter espaços.",
    }),
});

export { updateUserPasswordSchema };
