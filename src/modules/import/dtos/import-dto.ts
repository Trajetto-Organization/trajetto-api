import type { SortOrder } from "@/shared/pagination/list-query";
import type {
  ImportGroup,
  ImportListSearchMeta,
  ImportSortKey,
} from "../usecases/list-imports/import-list";

type ImportSource = "SPREADSHEET" | "NFE_XML";
type ImportStatus = "IN_PROGRESS" | "COMPLETED" | "REVERSED";

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
  routes: Array<{
    id: string;
    code: number;
    name: string | null;
    stops: number;
  }>;
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

/**
 * Opening an upload, before a single row exists.
 *
 * No counts and no report, because at this point there are none: the record is
 * written FIRST so every delivery and every route it creates can carry its id
 * from birth. A process that dies halfway then leaves rows that the undo can
 * still find — whereas stamping them afterwards leaves orphans that no undo
 * can ever group again, and the operator deletes two hundred rows by hand.
 */
interface CreateImportProps {
  source: ImportSource;
  filename: string;

  businessId: string;
  performedById: string;
}

/** Closing it: the counts and the per-row report, once they are known. */
interface FinishImportProps {
  imported: number;
  duplicated: number;
  invalid: number;

  report: ImportReport;
}

interface ListImportsProps {
  businessId: string;
  page: number;
  pageSize: number;
  /**
   * Whether each row carries its per-row report. Defaults to true, which is
   * what the web already in production expects; the current web asks for
   * false and reads one report at a time through `findImportById`.
   */
  includeReport?: boolean;
  sort?: ImportSortKey;
  order?: SortOrder;
  /** The Status and Origem filters; none keeps every upload. */
  statuses?: ImportStatus[];
  sources?: ImportSource[];
}

/**
 * An upload as the history table shows it: the counters, without the report.
 *
 * The report is one entry per spreadsheet line and is only ever read for one
 * upload at a time, when the operator opens it.
 */
type ImportSummary = Omit<ImportRecord, "report"> & { report?: ImportReport };

/** The page and the per-status-and-origin counts the filters are built from. */
interface ListImportsPage {
  data: ImportSummary[];
  groups: ImportGroup[];
}

interface ListImportsResult {
  data: ImportSummary[];
  total: number;
  /** Rides along in the NDJSON meta line: the filter counts. */
  meta: ImportListSearchMeta;
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

/**
 * A delivery the reversal removed, with what a webhook subscriber matches on
 * (our id, their code, the NF-e key).
 */
interface RemovedDelivery {
  id: string;
  code: string | null;
  invoice_key: string | null;
  invoice_number: string | null;
  recipient_name: string;
  city: string;
  uf: string;
}

export type {
  RemovedDelivery,
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ImportReport,
  ImportRowResult,
  ImportSource,
  ImportStatus,
  ImportSummary,
  ListImportsProps,
  ListImportsPage,
  ListImportsResult,
  ReversalResult,
  RowOutcome,
};
