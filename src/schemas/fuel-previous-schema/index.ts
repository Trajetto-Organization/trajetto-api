import { z } from "zod";

const getPreviousFuelParamsSchema = z.object({
  vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
});

const getPreviousFuelQuerySchema = z.object({
  date: z.string({
    required_error: "A data do abastecimento atual é obrigatória!",
  }),
  businessId: z
    .string({ required_error: "O ID da empresa é obrigatório!" })
    .uuid("O ID da empresa deve ser um UUID válido!"),
});

export { getPreviousFuelParamsSchema, getPreviousFuelQuerySchema };
