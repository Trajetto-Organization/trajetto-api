import { z } from "zod";

const updateDeleteBranchSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  branchId: z
    .string({ required_error: "ID da filial é obrigatório!" })
    .uuid("ID da filial é inválido."),
});

export { updateDeleteBranchSchema };
