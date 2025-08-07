import { z } from "zod";

const updateUserNameSchema = z.object({
  name: z.string().superRefine((value, ctx) => {
    if (value.length > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome não deve exceder 100 caracteres.",
      });

      return;
    }

    if (/\s{2,}/.test(value) && value.length !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome não deve conter espaços consecutivos.",
      });

      return;
    }

    if (!/^\S+ \S+(?: \S+)*$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Por favor, insira o nome completo.",
      });

      return;
    }
  }),
});

export { updateUserNameSchema };
