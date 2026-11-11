import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteFuelSchema = z.object({
  fuelId: z
    .string(fieldError({ required: "ID do abastecimento é obrigatório!" }))
    .uuid("ID do abastecimento é inválido."),
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
});

export { updateDeleteFuelSchema };
