import { z } from "zod";

const updateDeleteFineSchema = z.object({
  fineId: z.string().uuid("ID da multa deve ser um UUID válido"),
});

export { updateDeleteFineSchema };
