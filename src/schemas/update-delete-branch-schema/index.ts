import { z } from "zod";

const updateDeleteBranchSchema = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  branchId: z.string().uuid("O ID da filial é obrigatória!"),
});

export { updateDeleteBranchSchema };
