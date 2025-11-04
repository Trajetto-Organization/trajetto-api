import { z } from "zod";

const routeParamsSchema = z.object({
  routeId: z.string().uuid("O ID da rota deve ser um UUID válido."),
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
});

export { routeParamsSchema };
