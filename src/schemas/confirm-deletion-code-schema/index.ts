import { z } from "zod";

const confirmDeletionCodeSchema = z.object({
  code: z
    .string({ required_error: "O código de confirmação é obrigatório." })
    .regex(
      /^\d{6}$/,
      "O código de confirmação deve conter exatamente 6 dígitos numéricos.",
    ),
});

export { confirmDeletionCodeSchema };
