import { z } from "zod";

const updateDeleteFuelSchema = z.object({
  fuelId: z
    .string({ required_error: "ID do abastecimento é obrigatório!" })
    .uuid("ID do abastecimento é inválido."),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

export { updateDeleteFuelSchema };
