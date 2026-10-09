import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sortFields } from "@/shared/pagination/list-query";

import {
  FUEL_TYPE_SORT_FALLBACK,
  FUEL_TYPE_SORT_KEYS,
} from "@/modules/fuel-type/usecases/list-fuel-type/fuel-type-list";

const listFuelTypeSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(FUEL_TYPE_SORT_KEYS, FUEL_TYPE_SORT_FALLBACK),
});

export { listFuelTypeSchema };
