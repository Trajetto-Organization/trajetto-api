import { z } from "zod";

const updateDeleteVehicleChecklistSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  checklistId: z
    .string({ required_error: "ID do checklist é obrigatório!" })
    .uuid("ID do checklist é inválido."),
});

export { updateDeleteVehicleChecklistSchema };
