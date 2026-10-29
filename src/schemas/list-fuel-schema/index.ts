import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { idFacetField, sortFields } from "@/shared/pagination/list-query";

import {
  FUEL_SORT_FALLBACK,
  FUEL_SORT_KEYS,
} from "@/modules/fuel/usecases/list-fuel/fuel-list";

/** Querystring of GET /fuel/list-fuel and GET /fuel/export-fuel (same filters, 5.8). */
const listFuelFilterFields = {
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  branchId: idFacetField("Filiais."),
  vehicleId: idFacetField("Veículos."),
  fuelTypeId: idFacetField("Tipos de combustível."),
};

const listFuelSchema = listPagesSchema.extend({
  ...listFuelFilterFields,
  ...sortFields(FUEL_SORT_KEYS, FUEL_SORT_FALLBACK),
});

export { listFuelSchema, listFuelFilterFields };
