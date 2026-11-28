import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteBranchSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
  branchId: z
    .string(fieldError({ required: "ID da filial é obrigatório!" }))
    .uuid("ID da filial é inválido."),
});

export { updateDeleteBranchSchema };
