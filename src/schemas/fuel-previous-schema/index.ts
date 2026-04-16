import { z } from "zod";

const getPreviousFuelParamsSchema = z.object({
  vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
});

const getPreviousFuelQuerySchema = z.object({
  date: z.string({
    required_error: "A data do abastecimento atual é obrigatória!",
  }),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

export { getPreviousFuelParamsSchema, getPreviousFuelQuerySchema };
