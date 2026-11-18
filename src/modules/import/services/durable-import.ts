import type { ParsedRow } from "@/shared/delivery/spreadsheet-parser";

import type { ImportReport, ImportRowResult } from "../dtos/import-dto";

/**
 * The spreadsheet import as a durable job (plano-escala F3-23a): what its
 * row outcomes, its cursor and its request look like when they are written
 * down, so a run that resumes after a SIGKILL writes the very report the
 * run that died would have written.
 *
 * A row's outcome is one letter. The whole report line of a decided row is
 * rebuilt from it and the row the file still has (the file is the same: the
 * job reads the copy it stored), with the same words the in-memory path
 * writes — that path builds its lines here too, so the two cannot drift:
 *
 *  - `i`: imported (its message is the e-mail it went in without, if any);
 *  - `d`: duplicated: by the NF-e key when the row has one, by the order
 *    otherwise (the check before the write, the order lost to another
 *    upload under the lock, the unique index's P2002: the same line);
 *  - `x`: the write failed for another reason.
 */
type RowCode = "i" | "d" | "x";

const DUPLICATE_INVOICE_MESSAGE = "Esta nota já havia sido importada.";
const DUPLICATE_ORDER_MESSAGE =
  "Este pedido já havia sido importado para este embarcador.";
const ROW_FAILED_MESSAGE = "Não foi possível criar esta entrega.";

/** The report line of a decided row. */
function rowResultFor(row: ParsedRow, code: RowCode): ImportRowResult {
  const reference = row.invoice_key ?? row.code;

  switch (code) {
    case "i":
      return {
        line: row.line,
        outcome: "imported",
        recipient_name: row.recipient_name,
        reference,
        // Imported all the same; the note says which e-mail was left out
        // of the customer notices (recipient-email.ts).
        message: row.recipient_email_notice,
      };
    case "d":
      return {
        line: row.line,
        outcome: "duplicated",
        recipient_name: row.recipient_name,
        reference,
        message: row.invoice_key
          ? DUPLICATE_INVOICE_MESSAGE
          : DUPLICATE_ORDER_MESSAGE,
      };
    default:
      return {
        line: row.line,
        outcome: "invalid",
        recipient_name: row.recipient_name,
        reference,
        message: ROW_FAILED_MESSAGE,
      };
  }
}

/** A route the import built, as the report lists it. */
type BuiltRoute = ImportReport["routes"][number];

/** A route group already built by an earlier attempt, and its notes. */
interface BuiltGroup {
  route: BuiltRoute;

  /** What every row of the group was told (the vehicle left out…). */
  notes: string[];
}

/**
 * The job's cursor, written with each row (or batch) it creates, inside the
 * row's own transaction:
 *
 *  - `next`: the index in the parsed rows of the first row not decided;
 *  - `outcomes`: one letter per decided row, in order (`next` of them);
 *  - `keyless`: the delivery of each imported row with a route and neither
 *    an NF-e key nor an order number, by its line — the only ones a resumed
 *    run cannot find again by their identity for the routes;
 *  - `routes`: the route groups already built, by their key, with their
 *    notes, so a resume never builds one twice.
 */
interface SpreadsheetImportProgress {
  v: 1;
  next: number;
  outcomes: string;
  keyless: Record<string, string>;
  routes: Record<string, BuiltGroup>;
}

function emptyImportProgress(): SpreadsheetImportProgress {
  return { v: 1, next: 0, outcomes: "", keyless: {}, routes: {} };
}

/** The cursor as the job's row holds it, or null when it is not one. */
function parseImportProgress(raw: unknown): SpreadsheetImportProgress | null {
  if (typeof raw !== "object" || raw === null) return null;

  const value = raw as Partial<SpreadsheetImportProgress>;

  if (
    value.v !== 1 ||
    typeof value.next !== "number" ||
    typeof value.outcomes !== "string" ||
    value.outcomes.length !== value.next ||
    !/^[idx]*$/.test(value.outcomes)
  ) {
    return null;
  }

  return {
    v: 1,
    next: value.next,
    outcomes: value.outcomes,
    keyless: { ...(value.keyless ?? {}) },
    routes: { ...(value.routes ?? {}) },
  };
}

/** The cursor after deciding the row at `index` with `code`. */
function advanceImportProgress(
  progress: SpreadsheetImportProgress,
  index: number,
  code: RowCode,
  keyless?: { line: number; deliveryId: string },
): SpreadsheetImportProgress {
  if (index !== progress.next) {
    throw new Error(
      `durable import: row ${index} decided out of order (next ${progress.next})`,
    );
  }

  return {
    ...progress,
    next: index + 1,
    outcomes: progress.outcomes + code,
    keyless: keyless
      ? { ...progress.keyless, [String(keyless.line)]: keyless.deliveryId }
      : progress.keyless,
  };
}

/** What the upload asked for, as the job's payload carries it. */
interface SpreadsheetImportPayload {
  importId: string;

  /** The stored copy of the file (spreadsheetImports/…). */
  objectKey: string;

  filename: string;
  shipperId: string;

  /** Who uploaded it: the routes' events and the activity name them. */
  userId: string;

  /** The company's zone when it was uploaded: a route row's default day. */
  timeZone: string;
}

function parseImportPayload(raw: unknown): SpreadsheetImportPayload | null {
  if (typeof raw !== "object" || raw === null) return null;

  const value = raw as Record<string, unknown>;
  const fields = [
    "importId",
    "objectKey",
    "filename",
    "shipperId",
    "userId",
    "timeZone",
  ] as const;

  if (!fields.every((field) => typeof value[field] === "string")) return null;

  return Object.fromEntries(
    fields.map((field) => [field, value[field]]),
  ) as unknown as SpreadsheetImportPayload;
}

/**
 * Where an upload's file is stored for its job: under the company, named
 * after the import, with the extension the reader goes by.
 */
function importObjectKey(
  businessId: string,
  importId: string,
  filename: string,
): string {
  const extension = filename.toLowerCase().endsWith(".csv") ? ".csv" : ".xlsx";

  return `spreadsheetImports/${businessId}/${importId}${extension}`;
}

function importObjectContentType(objectKey: string): string {
  return objectKey.endsWith(".csv")
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export {
  DUPLICATE_INVOICE_MESSAGE,
  DUPLICATE_ORDER_MESSAGE,
  ROW_FAILED_MESSAGE,
  advanceImportProgress,
  emptyImportProgress,
  importObjectContentType,
  importObjectKey,
  parseImportPayload,
  parseImportProgress,
  rowResultFor,
};
export type {
  BuiltGroup,
  BuiltRoute,
  RowCode,
  SpreadsheetImportPayload,
  SpreadsheetImportProgress,
};
