import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
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
  ...tenantLockedShape,
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
