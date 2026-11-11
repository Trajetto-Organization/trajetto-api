import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteSupplierSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
  supplierId: z
    .string(fieldError({ required: "ID do fornecedor é obrigatório!" }))
    .uuid("ID do fornecedor é inválido."),
});

export { updateDeleteSupplierSchema };
