import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

/**
 * The scheduled purge's confirmation (plano-escala F3-25): the company's
 * corporate name, typed by the MASTER — the explicit act the screen's
 * second step asks for. Compared with the stored name by the use case.
 */
const scheduleBusinessPurgeSchema = z.object({
  confirmation: z
    .string(
      fieldError({
        required: "Digite a razão social da empresa para confirmar.",
      }),
    )
    .trim()
    .min(1, "Digite a razão social da empresa para confirmar.")
    .max(255, "A confirmação deve ter no máximo 255 caracteres.")
    .describe(
      "A razão social da empresa, exatamente como está cadastrada: a confirmação explícita da exclusão.",
    ),
});

export { scheduleBusinessPurgeSchema };
