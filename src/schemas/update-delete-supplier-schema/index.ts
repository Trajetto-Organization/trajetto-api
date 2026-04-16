import { z } from "zod";

const updateDeleteSupplierSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  supplierId: z
    .string({ required_error: "ID do fornecedor é obrigatório!" })
    .uuid("ID do fornecedor é inválido."),
});

export { updateDeleteSupplierSchema };
