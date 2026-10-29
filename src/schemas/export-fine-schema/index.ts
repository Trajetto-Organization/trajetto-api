import { exportReports } from "@/schemas/export-reports-schema";
import { listFineFilterFields } from "@/schemas/list-fine-schema";

/** The export takes the list's own filters (decision 5.8), plus the format. */
const exportFineQuerySchema = exportReports.extend(listFineFilterFields);

export { exportFineQuerySchema };
