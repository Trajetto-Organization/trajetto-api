import { z } from "zod";

const updateDeleteSupplierSchema = z.object({
  businessId: z.string().min(1, "O ID da empresa é obrigatório!"),
  supplierId: z.string().min(1, "O ID do fornecedor é obrigatório!"),
});

export { updateDeleteSupplierSchema };
