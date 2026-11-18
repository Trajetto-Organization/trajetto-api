import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { readSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import { AppError } from "@/shared/errors/AppError";
import {
  readSpreadsheetOffThread,
  spreadsheetReadsInFlight,
} from "@/modules/import/services/spreadsheet-worker";

/**
 * The spreadsheet read off the event loop (plano-escala F3-23b).
 *
 * exceljs loads the whole workbook at once: a 20k × 50 sheet cost +329 MB
 * of heap and a second of frozen event loop, on the thread that also
 * serves every other request and socket of the replica — and a workbook
 * heavier than the heap took the process down with everybody's requests.
 * It now runs on a worker thread with a heap ceiling of its own.
 *
 * What this pins:
 *  - the rows are the very ones the in-process reader gives, dates and
 *    rich text included, and exceljs never runs on this thread;
 *  - the reader's own refusals keep their sentence and code;
 *  - a workbook past the thread's heap is an AppError in pt-BR, and the
 *    process is still here to read the next file;
 *  - a read past the timeout is stopped;
 *  - SPREADSHEET_READS_PER_PROCESS threads at most, and 0 reads in process
 *    as before;
 *  - the build ships the thread's entry where the reader looks for it.
 *
 * It does not measure the event loop's lag: a duration, and a CI machine
 * descheduling the thread fails it with the work already off-thread (the
 * receipt renderer's test learned it). It checks the property instead.
 */

/** The minimum a development boot needs. */
const BASE_ENV = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const WHEN = new Date("2026-11-18T12:00:00.000Z");

async function workbook(rows: number, columns = 4): Promise<string> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Entregas");

  sheet.addRow(["Destinatário", "Cidade", "Data", "Observação"]);

  for (let index = 0; index < rows; index += 1) {
    const values: unknown[] = [
      `Cliente ${index}`,
      "São Paulo",
      WHEN,
      { richText: [{ text: "Rua das Flores, " }, { text: `${index}` }] },
    ];

    for (let extra = 4; extra < columns; extra += 1) {
      values.push(`célula ${index}-${extra} com algum texto para pesar`);
    }

    sheet.addRow(values);
  }

  const buffer = await book.xlsx.writeBuffer();

  return Buffer.from(buffer as ArrayBuffer).toString("base64");
}

/** The XLSX loader of THIS thread's copy of exceljs. */
function mainThreadLoads() {
  const xlsx = new ExcelJS.Workbook().xlsx;

  return vi.spyOn(Object.getPrototypeOf(xlsx), "load");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a read on the worker thread", () => {
  it("gives the rows the in-process reader gives, without exceljs on this thread", async () => {
    const content = await workbook(2_500);
    const expected = await readSpreadsheet("entregas.xlsx", content);

    const loads = mainThreadLoads();

    const rows = await readSpreadsheetOffThread("entregas.xlsx", content, {
      slots: 1,
    });

    expect(loads).not.toHaveBeenCalled();

    // More rows than one message carries: the slices are put back in order.
    expect(rows).toHaveLength(2_501);
    expect(rows).toEqual(expected);

    // A date is still a Date across the thread, and rich text its parts.
    expect(rows[1][2]).toBeInstanceOf(Date);
    expect((rows[1][2] as Date).toISOString()).toBe(WHEN.toISOString());
    expect(rows[7][3]).toEqual({
      richText: [{ text: "Rua das Flores, " }, { text: "6" }],
    });
  }, 30_000);

  it("reads a CSV there too", async () => {
    const csv = 'Destinatário;Cidade\nAna;São Paulo\n"Rua A, 1";Recife\n';
    const content = Buffer.from(csv, "utf8").toString("base64");

    await expect(
      readSpreadsheetOffThread("entregas.csv", content, { slots: 1 }),
    ).resolves.toEqual(await readSpreadsheet("entregas.csv", content));
  }, 30_000);

  it("keeps the reader's refusal, sentence and code", async () => {
    const csv = `${"a;b\n".repeat(20_002)}`;
    const content = Buffer.from(csv, "utf8").toString("base64");

    const error = await readSpreadsheetOffThread("entregas.csv", content, {
      slots: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 413,
      code: "SPREADSHEET_TOO_MANY_ROWS",
    });
  }, 30_000);

  it("says a file that does not open is not a spreadsheet, with a plain error", async () => {
    const content = Buffer.from("isto não é um zip").toString("base64");

    const error = await readSpreadsheetOffThread("entregas.xlsx", content, {
      slots: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
  }, 30_000);
});

describe("a workbook too heavy for the thread", () => {
  it("is an AppError in pt-BR, and the process reads the next file", async () => {
    // Thousands of long cells against a heap ceiling far below what they
    // take loaded: the thread runs out of heap, not the process.
    const heavy = await workbook(6_000, 30);

    const error = await readSpreadsheetOffThread("pesada.xlsx", heavy, {
      slots: 1,
      maxOldMb: 16,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 413,
      code: "SPREADSHEET_TOO_LARGE",
      message:
        "A planilha é grande demais para ser lida agora; divida em partes ou tente de novo.",
    });

    // Still here, and a fresh thread reads the next one.
    const light = await workbook(3);

    await expect(
      readSpreadsheetOffThread("leve.xlsx", light, { slots: 1 }),
    ).resolves.toHaveLength(4);
  }, 60_000);
});

describe("a read past the timeout", () => {
  it("is stopped with its own sentence", async () => {
    const content = await workbook(2_000);

    const error = await readSpreadsheetOffThread("lenta.xlsx", content, {
      slots: 1,
      timeoutMs: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      statusCode: 503,
      code: "SPREADSHEET_READ_TIMEOUT",
    });
    expect(spreadsheetReadsInFlight()).toEqual({ running: 0, waiting: 0 });
  }, 30_000);
});

describe("SPREADSHEET_READS_PER_PROCESS", () => {
  it("runs that many threads at most, the rest waiting their turn", async () => {
    const content = await workbook(500);

    const reads = [1, 2, 3].map(() =>
      readSpreadsheetOffThread("entregas.xlsx", content, { slots: 1 }),
    );

    // The first runs; the other two wait for its thread to end.
    expect(spreadsheetReadsInFlight()).toEqual({ running: 1, waiting: 2 });

    const results = await Promise.all(reads);

    expect(results.map((rows) => rows.length)).toEqual([501, 501, 501]);
    expect(spreadsheetReadsInFlight()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it("reads on the main thread with 0, inside the main heap, as before", async () => {
    const content = await workbook(3);
    const loads = mainThreadLoads();

    await expect(
      readSpreadsheetOffThread("entregas.xlsx", content, { slots: 0 }),
    ).resolves.toHaveLength(4);

    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("defaults to one thread, 60 s and the derived ceiling, and refuses what is out of range", () => {
    const parsed = envSchema.safeParse(BASE_ENV);

    if (!parsed.success) throw parsed.error;

    expect(parsed.data).toMatchObject({
      SPREADSHEET_READS_PER_PROCESS: 1,
      SPREADSHEET_READ_TIMEOUT_MS: 60_000,
    });
    expect(parsed.data.SPREADSHEET_WORKER_MAX_OLD_MB).toBeUndefined();

    for (const [name, value] of [
      ["SPREADSHEET_READS_PER_PROCESS", "-1"],
      ["SPREADSHEET_READS_PER_PROCESS", "5"],
      ["SPREADSHEET_WORKER_MAX_OLD_MB", "63"],
      ["SPREADSHEET_WORKER_MAX_OLD_MB", "769"],
      ["SPREADSHEET_READ_TIMEOUT_MS", "4999"],
    ] as const) {
      const refused = envSchema.safeParse({ ...BASE_ENV, [name]: value });

      expect(refused.success, `${name}=${value}`).toBe(false);
    }

    const empty = envSchema.safeParse({
      ...BASE_ENV,
      SPREADSHEET_READS_PER_PROCESS: "",
      SPREADSHEET_WORKER_MAX_OLD_MB: "",
      SPREADSHEET_READ_TIMEOUT_MS: "",
    });

    if (!empty.success) throw empty.error;

    expect(empty.data.SPREADSHEET_READS_PER_PROCESS).toBe(1);
  });
});

describe("the build", () => {
  it("ships the thread's entry where the reader looks for it", () => {
    const config = readFileSync(
      resolve(process.cwd(), "tsup.config.ts"),
      "utf8",
    );
    const reader = readFileSync(
      resolve(
        process.cwd(),
        "src/modules/import/services/spreadsheet-worker.ts",
      ),
      "utf8",
    );

    expect(config).toMatch(
      /"spreadsheet-read-worker":\s*"\.\/src\/modules\/import\/services\/spreadsheet-read-worker\.ts"/,
    );
    expect(reader).toContain('"spreadsheet-read-worker.js"');
  });
});
