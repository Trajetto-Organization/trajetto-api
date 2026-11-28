import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const getPreviousFuelParamsSchema = z.object({
  vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
});

const getPreviousFuelQuerySchema = z.object({
  date: z.string(
    fieldError({ required: "A data do abastecimento atual é obrigatória!" }),
  ),
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
});

export { getPreviousFuelParamsSchema, getPreviousFuelQuerySchema };
