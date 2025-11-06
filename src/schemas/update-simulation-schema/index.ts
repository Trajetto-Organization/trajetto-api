import { z } from "zod";

const updateSimulationSchema = z.object({
  name: z
    .string()
    .min(3, "O nome deve ter no mínimo 3 caracteres.")
    .max(100, "O nome deve ter no máximo 100 caracteres.")
    .optional(),
  description: z
    .string()
    .max(500, "A descrição deve ter no máximo 500 caracteres.")
    .optional()
    .nullable(),
  status: z
    .enum(["pending", "processing", "completed", "failed"], {
      errorMap: () => ({
        message:
          "Status inválido. Deve ser pending, processing, completed ou failed",
      }),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export { updateSimulationSchema };
