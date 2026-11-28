import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { PrismaClient } from "@prisma/client";

import type { ArchiveStorage } from "./archive-storage";
import {
  historyArchiveKey,
  historySourceOf,
  type HistorySource,
} from "./history-archive";

/**
 * A month of the delivery history, of one company, back from the archive
 * into a table of its own (plano-escala F5-16): what a legal request, a
 * dispute or an audit asks for after the month left the database (F5-17),
 * or while it is still there and the question is "what did the archive
 * keep". infra/scripts/archive-restore.ts is the command; this is the work.
 *
 * Nothing it does touches the history itself: the rows go to a new table
 * in the `archive_restore` schema, made LIKE the history table (the same
 * columns and types, no index, no foreign key, no default), which the
 * person who asked drops when the request is answered. Before a single
 * row is written, the object is checked against its manifest: the sha256
 * of the bytes, the header (the archive's columns, in order) and the row
 * count. One that does not add up is refused, and nothing is created.
 * All of it in one transaction: a failure leaves no half table behind.
 */

type RestoreDatabase = Pick<PrismaClient, "$queryRawUnsafe" | "$transaction">;

interface RestoreRequest {
  /** delivery_event or activity. */
  table: string;
  /** `YYYYMM`, `YYYY-MM` or `older`. */
  period: string;
  /** The company's id, or `_platform` for activity's rows of no company. */
  subject: string;
  /** The new table's name; one is made from the request when absent. */
  into?: string;
}

interface RestoreResult {
  table: string;
  partition: string;
  key: string;
  into: string;
  rows: number;
  sha256: string;
}

const RESTORE_SCHEMA = "archive_restore";

/** Rows per INSERT: 30 columns × 500 stays far from the 65.535 parameters. */
const RESTORE_BATCH = 500;

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

class ArchiveRestoreError extends Error {}

/** `202611` from `202611`, `2026-11` or `2026/11`; `older` as it is. */
function normalizePeriod(period: string): string {
  const trimmed = period.trim().toLowerCase();

  if (trimmed === "older") return trimmed;

  const match = /^(\d{4})[-/]?(\d{2})$/.exec(trimmed);

  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new ArchiveRestoreError(
      `período inválido: '${period}' (use AAAAMM, AAAA-MM ou older)`,
    );
  }

  return `${match[1]}${match[2]}`;
}

/**
 * The archive's CSV (history-archive.ts, historyCsvCell): RFC 4180 with an
 * unquoted empty cell for NULL and a quoted one for an empty string.
 */
function parseHistoryCsv(text: string): Array<Array<string | null>> {
  const records: Array<Array<string | null>> = [];
  let record: Array<string | null> = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  let index = 0;

  const endCell = () => {
    record.push(wasQuoted || cell !== "" ? cell : null);
    cell = "";
    wasQuoted = false;
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }

        quoted = false;
        index += 1;
        continue;
      }

      cell += char;
      index += 1;
      continue;
    }

    if (char === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      endCell();
      index += 1;
      continue;
    }

    if (char === "\n") {
      endCell();
      records.push(record);
      record = [];
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  if (quoted) throw new ArchiveRestoreError("CSV do arquivo truncado");

  if (cell !== "" || wasQuoted || record.length > 0) {
    endCell();
    records.push(record);
  }

  return records;
}

function restoreTableName(
  source: HistorySource,
  period: string,
  subject: string,
): string {
  const who = subject
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase();

  return `${source.table}_${period}_${who || "x"}_${Date.now().toString(36)}`;
}

async function restoreHistoryArchive(
  request: RestoreRequest,
  deps: { db: RestoreDatabase; storage: ArchiveStorage },
): Promise<RestoreResult> {
  const source = historySourceOf(request.table);

  if (!source) {
    throw new ArchiveRestoreError(
      `tabela sem arquivo de histórico: '${request.table}' (delivery_event ou activity)`,
    );
  }

  const period = normalizePeriod(request.period);
  const partition = `${source.table}_${period}`;
  const subject = request.subject.trim();
  const into = request.into ?? restoreTableName(source, period, subject);

  if (!TABLE_NAME.test(into)) {
    throw new ArchiveRestoreError(
      `nome de tabela inválido: '${into}' (minúsculas, dígitos e _, até 63)`,
    );
  }

  const [manifest] = await deps.db.$queryRawUnsafe<
    Array<{
      status: string;
      object_key: string;
      row_count: number | null;
      sha256: string | null;
    }>
  >(
    `SELECT "status"::text AS status, "object_key", "row_count", "sha256"
       FROM "archive_manifest"
      WHERE "partition_name" = $1 AND "businessId" = $2`,
    partition,
    subject,
  );

  if (!manifest) {
    throw new ArchiveRestoreError(
      `nada arquivado de '${subject}' em ${partition}`,
    );
  }

  if (manifest.status !== "ARCHIVED" || !manifest.sha256) {
    throw new ArchiveRestoreError(
      `o arquivo de '${subject}' em ${partition} está ${manifest.status}, não ARCHIVED`,
    );
  }

  const key = historyArchiveKey(source, partition, subject);

  if (manifest.object_key !== key) {
    throw new ArchiveRestoreError(
      `o manifesto aponta ${manifest.object_key}, não ${key}`,
    );
  }

  const bytes = await deps.storage.get(key);

  if (!bytes) {
    throw new ArchiveRestoreError(`o objeto ${key} não está no bucket`);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (sha256 !== manifest.sha256) {
    throw new ArchiveRestoreError(
      `o sha256 de ${key} não confere com o manifesto`,
    );
  }

  const [header, ...rows] = parseHistoryCsv(gunzipSync(bytes).toString("utf8"));

  if (header?.join(",") !== source.columns.join(",")) {
    throw new ArchiveRestoreError(
      `as colunas de ${key} não são as de ${source.table}`,
    );
  }

  if (rows.length !== Number(manifest.row_count)) {
    throw new ArchiveRestoreError(
      `${key} tem ${rows.length} linhas; o manifesto diz ${manifest.row_count}`,
    );
  }

  const columns = source.columns.map(quote).join(", ");
  const target = `${quote(RESTORE_SCHEMA)}.${quote(into)}`;

  await deps.db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE SCHEMA IF NOT EXISTS ${quote(RESTORE_SCHEMA)}`,
      );
      // No IF NOT EXISTS: a name already taken is refused, never appended to.
      await tx.$executeRawUnsafe(
        `CREATE TABLE ${target} (LIKE ${quote(source.table)})`,
      );

      for (let start = 0; start < rows.length; start += RESTORE_BATCH) {
        const batch = rows.slice(start, start + RESTORE_BATCH);
        const values = batch
          .map(
            (_row, line) =>
              `(${source.columns
                .map(
                  (_column, at) => `$${line * source.columns.length + at + 1}`,
                )
                .join(", ")})`,
          )
          .join(", ");

        await tx.$executeRawUnsafe(
          `INSERT INTO ${target} (${columns}) VALUES ${values}`,
          ...batch.flat(),
        );
      }
    },
    { timeout: 10 * 60_000, maxWait: 60_000 },
  );

  return {
    table: source.table,
    partition,
    key,
    into: `${RESTORE_SCHEMA}.${into}`,
    rows: rows.length,
    sha256,
  };
}

export {
  ArchiveRestoreError,
  RESTORE_SCHEMA,
  normalizePeriod,
  parseHistoryCsv,
  restoreHistoryArchive,
};
export type { RestoreDatabase, RestoreRequest, RestoreResult };
