import { z } from "zod";

const updateDeleteFuelSchema = z.object({
  id: z.string().uuid("O ID do abastecimento deve ser um UUID válido."),
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  fuelId: z.string().uuid("O ID do abastecimento deve ser um UUID válido."),
});

export { updateDeleteFuelSchema };
