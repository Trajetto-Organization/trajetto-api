import { z } from "zod";

const updateDeleteDriverSchema = z.object({
  driverId: z.string().uuid("O ID do motorista deve ser um UUID válido."),
});

export { updateDeleteDriverSchema };
