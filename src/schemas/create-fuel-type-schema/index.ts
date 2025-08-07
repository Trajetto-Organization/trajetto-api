import { z } from "zod";

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

const createFuelTypeSchema = z.object({
  description: z.enum(allowedFuelTypes, {
    errorMap: () => ({
      message: "Combustível inválido. Selecione uma opção válida.",
    }),
  }),
});

export { createFuelTypeSchema };
