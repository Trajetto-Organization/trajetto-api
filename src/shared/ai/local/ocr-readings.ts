/**
 * OCR lines -> the product's answer (ADR 0010 §3, item 2).
 *
 * The trajetto-ai service only transcribes; these rules decide what the lines
 * say, in TypeScript, so a business rule never lives in the container and a
 * new engine never changes a rule. A port of the benchmark's
 * scripts/ai-benchmark/ocr-rules.mjs (the version measured on 05/10/2026),
 * with three product decisions on top:
 *
 * - the signature is never answered (`tem_assinatura: "nao_sei"`,
 *   `assinatura_avaliada: false`): OCR does not see ink, so a receipt is never
 *   approved by the machine alone;
 * - the recipient's name is never answered: nothing measured how often it is
 *   right, and it must not be shown as "read";
 * - fraud is never answered (`fraude_avaliada: false`): no candidate caught a
 *   photo of a screen (O09), so the odometer is at most "km confere".
 *
 * Pure: no imports, so the benchmark loads this file from source and measures
 * exactly what the product runs.
 */

/** Bumped on any change of these rules; recorded on AIProviderAttempt.model. */
const OCR_RULES_VERSION = 1;

interface OcrLine {
  text: string;
  score: number;

  /** Four [x, y] points, as the engine returns them. */
  box: number[][];
}

interface PlacedLine extends OcrLine {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  h: number;
  w: number;
}

/** The proof answer as ai-answers.ts validates it. */
interface OcrProofAnswer {
  e_canhoto: "sim" | "nao" | "nao_sei";
  numero_documento_lido: string | null;
  data_recebimento_lida: string | null;
  tem_assinatura: "nao_sei";
  assinatura_avaliada: false;
  nome_recebedor_lido: null;
  legivel: "sim" | "nao" | "nao_sei";
  qualidade_foto: number;
  confianca: number;
  observacao: string;
}

interface OcrOdometerAnswer {
  valor_lido: number | null;
  confianca: number;
  legivel: boolean;
  sinais_fraude: false;
  fraude_avaliada: false;
  motivos_fraude: string[];
  observacao: string;
}

function normalize(text: unknown): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function compact(text: unknown): string {
  return normalize(text).replace(/[^A-Z0-9]/g, "");
}

/** Axis-aligned box of a 4-point polygon, plus its centre and height. */
function geometry(line: OcrLine): PlacedLine {
  const xs = line.box.map((point) => point[0]);
  const ys = line.box.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    ...line,
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    h: Math.max(1, maxY - minY),
    w: Math.max(1, maxX - minX),
  };
}

const DATE_PATTERN = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/;
const INVOICE_PATTERN = /(\d{3})\s*[.,]?\s*(\d{3})\s*[.,]?\s*(\d{3})/;

function meanScore(lines: Array<{ score: number }>): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.score, 0) / lines.length;
}

/** Three decimals, as the benchmark recorded them. */
function round3(value: number): number {
  return Number(value.toFixed(3));
}

// ---------------------------------------------------------------------------
// Receipt (canhoto)
// ---------------------------------------------------------------------------

const RECEIPT_KEYS = [
  "RECEBEMOS",
  "DATADERECEBIMENTO",
  "ASSINATURADORECEBEDOR",
  "IDENTIFICACAOEASSINATURA",
];

const NOT_RECEIPT_KEYS = [
  "NFCE",
  "CONSUMIDORELETRONICA",
  "DOCUMENTOAUXILIARDANOTAFISCALDECONSUMIDOR",
];

function findLabel(lines: PlacedLine[], key: string): PlacedLine | null {
  return lines.find((line) => compact(line.text).includes(key)) ?? null;
}

/**
 * The candidate nearest to a label, inside the field it names: below the
 * label, within a few label heights, and in the label's column. A full DANFE
 * under the stub has dates of its own, and none of them is the receiving one.
 */
function nearestBelow(
  label: PlacedLine,
  candidates: PlacedLine[],
  maxHeights = 6,
): PlacedLine | null {
  let best: PlacedLine | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (candidate === label) continue;
    if (candidate.cy < label.minY) continue;
    if (candidate.cy - label.cy > maxHeights * label.h) continue;
    if (
      candidate.cx < label.minX - 0.4 * label.w ||
      candidate.cx > label.maxX + 0.8 * label.w
    ) {
      continue;
    }

    const dx = Math.max(0, label.minX - candidate.maxX, candidate.minX - label.maxX);
    const dy = candidate.cy - label.cy;
    const distance = Math.hypot(dx, dy);

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * A day/month that can exist. ai-rules.ts parses it again, strictly (31/02
 * and a "/" read as "1" — "27109/2026", benchmark P11 — are not days).
 */
function plausibleDate(text: string): string | null {
  const match = String(text).match(DATE_PATTERN);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);

  return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? match[0] : null;
}

function proofFromLines(rawLines: OcrLine[]): OcrProofAnswer {
  const lines = rawLines.map(geometry);
  const all = lines.map((line) => compact(line.text)).join("|");

  const receiptHits = RECEIPT_KEYS.filter((key) => all.includes(key)).length;
  const notReceipt = NOT_RECEIPT_KEYS.some((key) => all.includes(key));

  const isReceipt: OcrProofAnswer["e_canhoto"] =
    receiptHits >= 1 && !notReceipt
      ? "sim"
      : lines.length >= 3 || notReceipt
        ? "nao"
        : "nao_sei";

  // The invoice number: the 000.000.000 group (stub's "Nº", or the DANFE's).
  let number: string | null = null;

  for (const line of lines) {
    const text = normalize(line.text);
    if (/CHAVE|PROTOCOLO|CNPJ|INSCRICAO/.test(text)) continue;

    const match = text.match(INVOICE_PATTERN);
    if (
      match &&
      match.index !== undefined &&
      !/\d/.test(
        text.slice(match.index + match[0].length, match.index + match[0].length + 1),
      )
    ) {
      number = `${match[1]}${match[2]}${match[3]}`;
      break;
    }
  }

  // The receiving date: the date-like text nearest below the DATA DE
  // RECEBIMENTO label. The printed EMISSÃO date sits elsewhere and is never
  // taken ("any date on the paper" is not enough, decision 6.9).
  const dateLabel = findLabel(lines, "DATADERECEBIMENTO");
  const dateLines = lines.filter(
    (line) =>
      line !== dateLabel &&
      plausibleDate(line.text) &&
      !/EMISS|VALOR|R\$|SAIDA|ENTRADA/.test(normalize(line.text)),
  );

  let date: string | null = null;

  if (dateLabel) {
    const found = nearestBelow(dateLabel, dateLines);
    if (found) date = plausibleDate(found.text);
  } else if (!all.includes("DANFE")) {
    // Label lost to blur: a stub alone has one handwritten date, a line of
    // its own (the printed EMISSÃO date sits inside the long RECEBEMOS line).
    const alone = dateLines.find((line) => compact(line.text).length <= 10);
    if (alone) date = plausibleDate(alone.text);
  }

  const quality = meanScore(lines);

  const legible: OcrProofAnswer["legivel"] =
    isReceipt === "sim" && number
      ? "sim"
      : lines.length < 3 || quality < 0.6
        ? "nao"
        : "nao_sei";

  return {
    e_canhoto: isReceipt,
    numero_documento_lido: number,
    data_recebimento_lida: date,
    tem_assinatura: "nao_sei",
    assinatura_avaliada: false,
    nome_recebedor_lido: null,
    legivel: legible,
    qualidade_foto: round3(quality),
    confianca: round3(quality),
    observacao: `Leitura automática (OCR): ${lines.length} linhas.`,
  };
}

// ---------------------------------------------------------------------------
// Odometer
// ---------------------------------------------------------------------------

/**
 * The usual OCR letter-for-digit swaps, applied only to a token that is
 * already mostly digits (an odometer field never holds letters).
 */
const DIGIT_SWAPS: Record<string, string> = {
  O: "0",
  o: "0",
  D: "0",
  Q: "0",
  I: "1",
  l: "1",
  "|": "1",
  Z: "2",
  z: "2",
  S: "5",
  s: "5",
  B: "8",
  G: "6",
  b: "6",
  g: "9",
};

function asDigits(text: string): string {
  const trimmed = text.trim();
  if (!/^[0-9A-Za-z|]{5,7}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "").length;
  if (digits / trimmed.length < 0.6) return trimmed;

  return [...trimmed].map((char) => DIGIT_SWAPS[char] ?? char).join("");
}

interface DigitRun {
  text: string;
  h: number;
  cx: number;
  cy: number;
  score: number;
  merged: boolean;
}

/**
 * Digit runs, merging the drum odometer's one-digit boxes that sit on the
 * same row next to each other.
 */
function digitRuns(placed: PlacedLine[]): DigitRun[] {
  const lines = placed.map((line) => ({ ...line, text: asDigits(line.text) }));

  // "100 120": two dial labels the detector boxed together, not a reading.
  const numeric = lines.filter(
    (line) => /^\s*\d[\d\s]*$/.test(line.text) && !/\d{2,}\s+\d{2,}/.test(line.text),
  );

  const runs: DigitRun[] = numeric.map((line) => ({
    text: line.text.replace(/\s/g, ""),
    h: line.h,
    cx: line.cx,
    cy: line.cy,
    score: line.score,
    merged: false,
  }));

  // A drum odometer may come back one box per digit: merge single digits
  // that sit side by side on one row (never multi-digit dial labels).
  const singles = numeric
    .filter((line) => line.text.trim().length === 1)
    .sort((a, b) => a.minX - b.minX);

  const used = new Set<PlacedLine>();

  for (const start of singles) {
    if (used.has(start)) continue;

    const run = [start];
    used.add(start);
    let last = start;

    for (const next of singles) {
      if (used.has(next)) continue;

      const sameRow = Math.abs(next.cy - last.cy) < 0.4 * Math.max(next.h, last.h);
      const gap = next.minX - last.maxX;

      if (sameRow && gap > -0.3 * last.h && gap < 0.8 * last.h) {
        run.push(next);
        used.add(next);
        last = next;
      }
    }

    if (run.length >= 4) {
      runs.push({
        text: run.map((line) => line.text.trim()).join(""),
        h: Math.max(...run.map((line) => line.h)),
        cx: (run[0].minX + run[run.length - 1].maxX) / 2,
        cy: run.reduce((sum, line) => sum + line.cy, 0) / run.length,
        score: meanScore(run),
        merged: true,
      });
    }
  }

  return runs;
}

function odometerFromLines(rawLines: OcrLine[]): OcrOdometerAnswer {
  const lines = rawLines.map(geometry);
  const all = lines.map((line) => compact(line.text)).join("|");
  const hasContext = /ODO|KM|TRIP/.test(all);

  const runs = digitRuns(lines).filter((run) =>
    run.text.length >= 5 && run.text.length <= 7
      ? true
      : run.text.length === 4 && hasContext,
  );

  let chosen: DigitRun | null = null;

  const odoLabel = lines.find(
    (line) => compact(line.text) === "ODO" || compact(line.text).startsWith("ODO"),
  );

  if (odoLabel && runs.length > 0) {
    chosen =
      runs
        .filter((run) => run.cy >= odoLabel.minY - odoLabel.h)
        .sort(
          (a, b) =>
            Math.hypot(a.cx - odoLabel.cx, a.cy - odoLabel.cy) -
            Math.hypot(b.cx - odoLabel.cx, b.cy - odoLabel.cy),
        )[0] ?? null;
  }

  // No ODO label: the tallest single-line run, then the longest.
  chosen ??=
    [...runs].sort(
      (a, b) =>
        Number(a.merged) - Number(b.merged) ||
        b.h - a.h ||
        b.text.length - a.text.length,
    )[0] ?? null;

  return {
    valor_lido: chosen ? Number(chosen.text) : null,
    confianca: round3(chosen?.score ?? 0),
    legivel: Boolean(chosen),
    sinais_fraude: false,
    fraude_avaliada: false,
    motivos_fraude: [],
    observacao: `Leitura automática (OCR): ${lines.length} linhas, ${runs.length} candidatos.`,
  };
}

export { OCR_RULES_VERSION, odometerFromLines, proofFromLines };
export type { OcrLine, OcrOdometerAnswer, OcrProofAnswer };
