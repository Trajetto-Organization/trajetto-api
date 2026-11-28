import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  FUEL_ALERTS,
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
  // 05/11/2026: the refuellings the office should look at.
  alerts: facetField(
    FUEL_ALERTS,
    "Alertas: os abastecimentos com qualquer um dos informados. RECENT_REFUEL = outro abastecimento do mesmo veículo a menos de 30 minutos deste.",
  ),
};

const listFuelSchema = listPagesSchema.extend({
  ...listFuelFilterFields,
  ...sortFields(FUEL_SORT_KEYS, FUEL_SORT_FALLBACK),
});

export { listFuelSchema, listFuelFilterFields };
