import { z } from "zod";

const updateDeleteBusinessSchema = z.object({
  businessId: z.string().min(1, "O ID da empresa é obrigatório!"),
});

export { updateDeleteBusinessSchema };
