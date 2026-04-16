import { z } from "zod";

const updateDeleteFuelTypeSchema = z.object({
  fuelTypeId: z
    .string({ required_error: "ID do tipo de combustível é obrigatório!" })
    .uuid("ID do tipo de combustível é inválido."),
});

export { updateDeleteFuelTypeSchema };
