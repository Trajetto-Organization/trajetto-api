import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const confirmDeletionCodeSchema = z.object({
  code: z
    .string(fieldError({ required: "O código de confirmação é obrigatório." }))
    .regex(
      /^\d{6}$/,
      "O código de confirmação deve conter exatamente 6 dígitos numéricos.",
    ),
});

export { confirmDeletionCodeSchema };
