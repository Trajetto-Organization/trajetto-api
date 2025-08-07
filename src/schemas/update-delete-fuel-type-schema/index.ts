import { z } from "zod";

const updateDeleteFuelTypeSchema = z.object({
  fuelTypeId: z.string().uuid("O ID do tipo de combustível é obrigatório!"),
});

export { updateDeleteFuelTypeSchema };
