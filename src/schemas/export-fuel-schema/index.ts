import { exportReports } from "@/schemas/export-reports-schema";
import { listFuelFilterFields } from "@/schemas/list-fuel-schema";

/** The export takes the list's own filters (decision 5.8), plus the format. */
const exportFuelQuerySchema = exportReports.extend(listFuelFilterFields);

export { exportFuelQuerySchema };
