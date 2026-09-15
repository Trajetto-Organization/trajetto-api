import {
  HEADER_LOOKUP,
  REQUIRED_KEYS,
  TEMPLATE_COLUMNS,
  normalizeHeader,
} from "./spreadsheet-template";

/**
 * Turning a spreadsheet into deliveries, decided here and nowhere else.
 *
 * Pure: it takes a matrix of cell values — whatever read them, exceljs or a
 * CSV split — and answers what each row means or what is wrong with it. The
 * reading half has no decisions in it; this half is all decisions, and it is
 * the half that has to be right at 6am when a dispatcher pastes a file from
 * their customer's ERP.
 *
 * Nothing here throws on bad data. A spreadsheet with one broken row out of
 * two hundred must import a hundred and ninety-nine and say precisely what
 * happened to the other one — the same rule the XML import already follows,
 * for the same reason: an import screen that refuses the whole upload over one
 * cell is an import screen people stop using.
 */
interface ParsedRow {
  /** 1-based, as the operator sees it in the spreadsheet (header is row 1). */
  line: number;

  kind: "DELIVERY" | "PICKUP";

  recipient_name: string;
  recipient_document: string | null;
  recipient_telephone: string | null;
  recipient_email: string | null;

  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string | null;
  complement: string | null;
  neighborhood: string | null;

  invoice_key: string | null;
  invoice_number: string | null;
  code: string | null;

  scheduled_date: Date | null;
  notes: string | null;

  item: {
    description: string;
    quantity: number;
    unit: string | null;
    unit_value: number | null;
  } | null;

  route: {
    name: string | null;
    date: Date | null;
    driverCnh: string | null;
    vehiclePlate: string | null;
  } | null;
}

interface RowError {
  line: number;
  column: string | null;
  message: string;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];

  /** Headers in the file we did not recognise — reported, never fatal. */
  unknownHeaders: string[];
}

function cell(value: unknown): string {
  if (value == null) return "";

  // exceljs hands back rich text, formulas and dates as objects.
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const rich = value as { text?: string; result?: unknown; richText?: Array<{ text: string }> };

    if (typeof rich.text === "string") return rich.text.trim();

    if (Array.isArray(rich.richText)) {
      return rich.richText.map((part) => part.text).join("").trim();
    }

    if (rich.result != null) return String(rich.result).trim();

    return "";
  }

  return String(value).trim();
}

const digitsOnly = (value: string) => value.replace(/\D/g, "");

/**
 * Dates as people write them, and as machines export them.
 *
 * `16/09/2026` is what a Brazilian dispatcher types; `2026-09-16` is what
 * every export produces; a Date arrives when the cell was formatted as one.
 * Anything else is refused rather than guessed at — a date silently read as
 * the wrong day sends a truck out tomorrow instead of today.
 */
function parseDate(raw: string): Date | "invalid" | null {
  if (!raw) return null;

  const brazilian = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (brazilian) {
    const [, day, month, year] = brazilian;
    const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);

    return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);

    return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
  }

  return "invalid";
}

/** "45,90" and "45.90" are the same number; "1.234,56" is too. */
function parseDecimal(raw: string): number | "invalid" | null {
  if (!raw) return null;

  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : "invalid";
}

function parseKind(raw: string): "DELIVERY" | "PICKUP" | "invalid" {
  const value = normalizeHeader(raw);

  if (!value || value === "entrega" || value === "delivery") return "DELIVERY";
  if (value === "coleta" || value === "pickup") return "PICKUP";

  return "invalid";
}

/**
 * Maps the file's header row onto our keys.
 *
 * Returns the index of each key we recognised, plus whatever we did not. An
 * unknown header is reported and ignored: a customer's own spreadsheet
 * regularly carries columns that mean nothing to us, and refusing the file
 * over a stray "Vendedor" column would be refusing the file for being real.
 */
function mapHeaders(headerRow: unknown[]): {
  index: Map<string, number>;
  unknownHeaders: string[];
} {
  const index = new Map<string, number>();
  const unknownHeaders: string[] = [];

  headerRow.forEach((raw, position) => {
    const text = cell(raw);

    if (!text) return;

    const key = HEADER_LOOKUP.get(normalizeHeader(text));

    if (!key) {
      unknownHeaders.push(text);
      return;
    }

    // First occurrence wins: a duplicated column is the operator's copy-paste,
    // and reading the second one would silently prefer the copy.
    if (!index.has(key)) index.set(key, position);
  });

  return { index, unknownHeaders };
}

function headerOf(key: string): string {
  return TEMPLATE_COLUMNS.find((column) => column.key === key)?.header ?? key;
}

/**
 * The whole file: a header row, then one row per document.
 *
 * `startLine` is 1 for the header, so the first data row is line 2 — which is
 * what the operator sees in the corner of their screen, and what an error
 * message has to name for them to find it.
 */
function parseDeliverySpreadsheet(matrix: unknown[][]): ParseResult {
  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  const [headerRow, ...dataRows] = matrix;

  if (!headerRow) {
    return {
      rows,
      errors: [
        { line: 1, column: null, message: "A planilha está vazia." },
      ],
      unknownHeaders: [],
    };
  }

  const { index, unknownHeaders } = mapHeaders(headerRow);

  const missing = REQUIRED_KEYS.filter((key) => !index.has(key));

  if (missing.length > 0) {
    // A missing required COLUMN is the one failure that is fatal for the whole
    // file: every row would report the same thing, and two hundred identical
    // errors is a report nobody reads.
    return {
      rows,
      errors: [
        {
          line: 1,
          column: null,
          message:
            "A planilha não tem as colunas obrigatórias: " +
            missing.map(headerOf).join(", ") +
            ". Baixe o modelo e confira o cabeçalho.",
        },
      ],
      unknownHeaders,
    };
  }

  dataRows.forEach((raw, position) => {
    const line = position + 2;

    const read = (key: string): string => {
      const at = index.get(key);

      return at === undefined ? "" : cell(raw?.[at]);
    };

    // A blank line in the middle of a spreadsheet is somebody's spacing, not a
    // delivery with no name.
    const isBlank = TEMPLATE_COLUMNS.every((column) => !read(column.key));

    if (isBlank) return;

    const rowErrors: RowError[] = [];

    const fail = (column: string | null, message: string) =>
      rowErrors.push({ line, column, message });

    const kind = parseKind(read("tipo"));

    if (kind === "invalid") {
      fail(headerOf("tipo"), 'Use "entrega" ou "coleta".');
    }

    const recipient_name = read("recipient_name");

    if (!recipient_name) {
      fail(headerOf("recipient_name"), "O destinatário é obrigatório.");
    }

    const cep = digitsOnly(read("cep"));

    if (!cep) {
      fail(headerOf("cep"), "O CEP é obrigatório.");
    } else if (cep.length !== 8) {
      fail(headerOf("cep"), "O CEP deve ter 8 dígitos.");
    }

    const city = read("city");

    if (!city) fail(headerOf("city"), "A cidade é obrigatória.");

    const uf = read("uf").toUpperCase();

    if (!uf) {
      fail(headerOf("uf"), "A UF é obrigatória.");
    } else if (!/^[A-Z]{2}$/.test(uf)) {
      fail(headerOf("uf"), "A UF deve ter 2 letras.");
    }

    const street = read("street");

    if (!street) fail(headerOf("street"), "O logradouro é obrigatório.");

    const documentDigits = digitsOnly(read("recipient_document"));

    if (
      documentDigits &&
      documentDigits.length !== 11 &&
      documentDigits.length !== 14
    ) {
      fail(
        headerOf("recipient_document"),
        "O documento deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos).",
      );
    }

    const invoiceKeyDigits = digitsOnly(read("invoice_key"));

    if (invoiceKeyDigits && invoiceKeyDigits.length !== 44) {
      fail(headerOf("invoice_key"), "A chave da NF-e deve ter 44 dígitos.");
    }

    const scheduled = parseDate(read("scheduled_date"));

    if (scheduled === "invalid") {
      fail(
        headerOf("scheduled_date"),
        "Data inválida. Use 16/09/2026 ou 2026-09-16.",
      );
    }

    const routeDate = parseDate(read("route_date"));

    if (routeDate === "invalid") {
      fail(headerOf("route_date"), "Data inválida. Use 16/09/2026 ou 2026-09-16.");
    }

    // Items: a quantity with no description is a typo, and a description with
    // no quantity is one item.
    const itemDescription = read("item_description");
    const itemQuantityRaw = read("item_quantity");

    const itemQuantity = parseDecimal(itemQuantityRaw);
    const itemValue = parseDecimal(read("item_unit_value"));

    if (itemQuantity === "invalid") {
      fail(headerOf("item_quantity"), "Quantidade inválida.");
    }

    if (itemValue === "invalid") {
      fail(headerOf("item_unit_value"), "Valor unitário inválido.");
    }

    if (!itemDescription && itemQuantityRaw) {
      fail(
        headerOf("item_description"),
        "Há quantidade sem descrição do item.",
      );
    }

    const routeName = read("route_name");
    const routeCnh = read("route_driver_cnh");
    const routePlate = read("route_vehicle_plate").toUpperCase();

    const wantsRoute = Boolean(routeName || routeCnh || routePlate || routeDate);

    // The route needs a driver. Naming a route with nobody to drive it would
    // create a plan that can never be released, which is worse than saying so
    // now — the operator is looking at the report.
    if (wantsRoute && !routeCnh) {
      fail(
        headerOf("route_driver_cnh"),
        "Para criar a rota, informe a CNH do motorista.",
      );
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    rows.push({
      line,
      kind: kind as "DELIVERY" | "PICKUP",

      recipient_name,
      recipient_document: documentDigits || null,
      recipient_telephone: digitsOnly(read("recipient_telephone")) || null,
      recipient_email: read("recipient_email") || null,

      cep,
      city,
      uf,
      street,
      address_number: read("address_number") || null,
      complement: read("complement") || null,
      neighborhood: read("neighborhood") || null,

      invoice_key: invoiceKeyDigits || null,
      invoice_number: read("invoice_number") || null,
      code: read("code") || null,

      scheduled_date: (scheduled as Date | null) ?? null,
      notes: read("notes") || null,

      item: itemDescription
        ? {
            description: itemDescription,
            // A described item with no quantity is one of it.
            quantity: (itemQuantity as number | null) ?? 1,
            unit: read("item_unit") || null,
            unit_value: (itemValue as number | null) ?? null,
          }
        : null,

      route: wantsRoute
        ? {
            name: routeName || null,
            date: (routeDate as Date | null) ?? null,
            driverCnh: digitsOnly(routeCnh) || routeCnh || null,
            vehiclePlate: routePlate || null,
          }
        : null,
    });
  });

  return { rows, errors, unknownHeaders };
}

export { parseDeliverySpreadsheet };
export type { ParseResult, ParsedRow, RowError };
