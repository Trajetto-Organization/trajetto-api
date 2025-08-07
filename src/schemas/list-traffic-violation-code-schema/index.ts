import { z } from "zod";

const listTrafficViolationCodeSchema = z.object({
  page: z.coerce.number().min(1, "Página deve ser maior que 0").default(1),
  pageSize: z.coerce
    .number()
    .min(1, "Tamanho da página deve ser maior que 0")
    .max(100, "Tamanho máximo da página é 100")
    .default(10),
  search: z.string().optional(),
  gravity: z
    .enum(["LIGHT", "MEDIUM", "SERIOUS", "VERY_SERIOUS", "NO_POINTS"])
    .optional(),
  violatorType: z.string().optional(),
});

export { listTrafficViolationCodeSchema };
