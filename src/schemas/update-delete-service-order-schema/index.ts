import { z } from "zod";

const updateDeleteServiceOrderSchema = z.object({
  serviceOrderId: z.string().min(1, "O ID da ordem de serviço é obrigatória!"),
});

export { updateDeleteServiceOrderSchema };
