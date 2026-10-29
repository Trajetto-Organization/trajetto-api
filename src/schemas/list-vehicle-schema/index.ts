import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { exportReports } from "@/schemas/export-reports-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import { VEHICLE_STATUSES } from "@/shared/vehicle/vehicle-rules";

import {
  VEHICLE_SORT_FALLBACK,
  VEHICLE_SORT_KEYS,
} from "@/modules/vehicle/usecases/list-vehicle/vehicle-list";

const businessIdQuery = z
  .string()
  .uuid("ID da empresa é inválido.")
  .optional()
  .describe(
    "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
  );

/** The filters the listing and its export share (decision 5.8). */
const vehicleFilterFields = {
  businessId: businessIdQuery,
  status: facetField(VEHICLE_STATUSES, "Status do veículo."),
  branchId: idFacetField("Filiais."),
};

const listVehicleSchema = listPagesSchema.extend({
  ...vehicleFilterFields,
  ...sortFields(VEHICLE_SORT_KEYS, VEHICLE_SORT_FALLBACK),
});

const exportVehicleSchema = exportReports.extend(vehicleFilterFields);

export { listVehicleSchema, exportVehicleSchema };
