import { z } from "zod";

const simulationIdSchema = z.object({
  simulationId: z.string().uuid("O ID da simulação deve ser um UUID válido."),
});

export { simulationIdSchema };
