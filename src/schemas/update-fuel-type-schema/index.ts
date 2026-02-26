import { z } from "zod";
import { emptyStringToNull } from "@/shared/utils/zod-schema-helpers";

const allowedFuelTypes = [
  "Gasolina",
  "Diesel",
  "Etanol",
  "GNV",
  "GLP",
  "Biodiesel",
  "Elétrico",
  "Hidrogênio",
] as const;

const updateFuelTypeSchema = z.object({
  description: z.preprocess(
    emptyStringToNull,
    z
      .enum(allowedFuelTypes, {
        errorMap: () => ({
          message: "Combustível inválido. Selecione uma opção válida.",
        }),
      })
      .optional()
      .nullable(),
  ),
});

export { updateFuelTypeSchema };
