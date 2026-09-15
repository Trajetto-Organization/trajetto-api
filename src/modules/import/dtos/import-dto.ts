type ImportSource = "SPREADSHEET" | "NFE_XML";
type ImportStatus = "COMPLETED" | "REVERSED";

type RowOutcome = "imported" | "duplicated" | "invalid";

/**
 * What happened to one line of the file, as the operator reads it.
 *
 * `line` is what they see in the corner of their spreadsheet, not an index:
 * an error that says "row 4" when the header is row 1 sends somebody to the
 * wrong line, and they fix the wrong thing.
 */
interface ImportRowResult {
  line: number;
  outcome: RowOutcome;

  recipient_name: string | null;
  reference: string | null;

  /** Why it was refused, or which delivery it duplicated. */
  message: string | null;
}

interface ImportReport {
  imported: number;
  duplicated: number;
  invalid: number;

  /** Headers in the file we did not recognise. Never fatal, always reported. */
  unknownHeaders: string[];

  rows: ImportRowResult[];

  /** Routes the file created, by name and number. */
  routes: Array<{ id: string; code: number; name: string | null; stops: number }>;
}

interface ImportRecord {
  id: string;
  source: ImportSource;
  status: ImportStatus;

  filename: string;

  imported: number;
  duplicated: number;
  invalid: number;

  report: ImportReport;

  reversed_at: Date | string | null;

  businessId: string;
  performedById: string;

  created_at: Date | string;
}

interface CreateImportProps {
  source: ImportSource;
  filename: string;

  imported: number;
  duplicated: number;
  invalid: number;

  report: ImportReport;

  businessId: string;
  performedById: string;
}

interface ListImportsProps {
  businessId: string;
  page: number;
  pageSize: number;
}

interface ListImportsResult {
  data: ImportRecord[];
  total: number;
}

/**
 * What an undo could and could not take back.
 *
 * Reversal is deliberately partial rather than all-or-nothing. A file loaded
 * at 6am and undone at 6:10 is usually untouched; one undone at noon has had
 * half its deliveries worked, and refusing the whole undo because three of
 * two hundred are in transit would leave the operator removing the other
 * hundred and ninety-seven by hand — which is how the ones they miss go out
 * on a truck.
 */
interface ReversalResult {
  removedDeliveries: number;
  removedRoutes: number;

  keptDeliveries: Array<{ id: string; recipient_name: string; reason: string }>;
  keptRoutes: Array<{ id: string; code: number; reason: string }>;
}

export type {
  CreateImportProps,
  ImportRecord,
  ImportReport,
  ImportRowResult,
  ImportSource,
  ImportStatus,
  ListImportsProps,
  ListImportsResult,
  ReversalResult,
  RowOutcome,
};
