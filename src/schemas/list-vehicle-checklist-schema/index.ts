import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { exportReports } from "@/schemas/export-reports-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  CHECKLIST_CONDITIONS,
  CHECKLIST_SORT_FALLBACK,
  CHECKLIST_SORT_KEYS,
} from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/checklist-list";

/** The filters the listing and its export share (decision 5.8). */
const checklistFilterFields = {
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  overall_condition: facetField(
    CHECKLIST_CONDITIONS,
    "Condição geral: approved (aprovado), approved_with_restrictions (com ressalvas), rejected (reprovado).",
  ),
  branchId: idFacetField("Filiais."),
  vehicleId: idFacetField("Veículos."),
};

const listVehicleChecklistSchema = listPagesSchema.extend({
  ...checklistFilterFields,
  ...sortFields(CHECKLIST_SORT_KEYS, CHECKLIST_SORT_FALLBACK),
});

const exportVehicleChecklistSchema = exportReports.extend(checklistFilterFields);

export { listVehicleChecklistSchema, exportVehicleChecklistSchema };
