import { z } from "zod";
import { emptyStringToNull } from "@/shared/utils/zod-schema-helpers";

const updateServiceOrderPartSchema = z.object({
  unit_price: z
    .number()
    .positive("O preço unitário deve ser um valor positivo.")
    .max(999999.99, "O preço unitário não pode exceder 999.999,99.")
    .optional(),
  quantity: z
    .number()
    .int("A quantidade deve ser um número inteiro.")
    .positive("A quantidade deve ser um valor positivo.")
    .max(9999, "A quantidade não pode exceder 9.999.")
    .optional(),
  discount_percentage: z.preprocess(
    emptyStringToNull,
    z
      .number()
      .nonnegative("O percentual de desconto deve ser um valor não negativo.")
      .max(100, "O percentual de desconto não pode exceder 100%.")
      .nullable()
      .optional(),
  ),
  partId: z.string().uuid("ID da peça é inválido.").optional(),
});

export { updateServiceOrderPartSchema };
