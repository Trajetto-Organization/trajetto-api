import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteVehicleChecklistSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
  checklistId: z
    .string(fieldError({ required: "ID do checklist é obrigatório!" }))
    .uuid("ID do checklist é inválido."),
});

export { updateDeleteVehicleChecklistSchema };
