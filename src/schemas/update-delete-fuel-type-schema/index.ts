import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteFuelTypeSchema = z.object({
  fuelTypeId: z
    .string(
      fieldError({ required: "ID do tipo de combustível é obrigatório!" }),
    )
    .uuid("ID do tipo de combustível é inválido."),
});

export { updateDeleteFuelTypeSchema };
