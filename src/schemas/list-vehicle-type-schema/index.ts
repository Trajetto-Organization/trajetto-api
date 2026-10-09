import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sortFields } from "@/shared/pagination/list-query";

import {
  VEHICLE_TYPE_SORT_FALLBACK,
  VEHICLE_TYPE_SORT_KEYS,
} from "@/modules/vehicle-type/usecases/list-vehicle-type/vehicle-type-list";

const listVehicleTypeSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(VEHICLE_TYPE_SORT_KEYS, VEHICLE_TYPE_SORT_FALLBACK),
});

export { listVehicleTypeSchema };
