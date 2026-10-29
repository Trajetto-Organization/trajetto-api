/**
 * Classical OCR (RapidOCR / PP-OCR, see ocr-server/) turned into the
 * product's answer shapes, so the same evaluate.mjs scores it with the
 * product's own rules (ai-rules.ts) as it scores a vision model.
 *
 * The OCR returns text lines with boxes; everything below is parsing and
 * geometry, the kind of code a "hybrid" pipeline would run: the invoice
 * number, the handwritten receiving date and the odometer digits come from
 * the OCR; what OCR cannot see (a signature, a fraud sign, a tyre) is
 * answered "nao_sei" here and left for a vision model (hybrid.mjs).
 *
 * Benchmark code, not product code.
 */

function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function compact(text) {
  return normalize(text).replace(/[^A-Z0-9]/g, "");
}

/** Axis-aligned box of a 4-point polygon, plus its centre and height. */
function geometry(line) {
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

const DATE_PATTERN = /(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{2,4}))?/;
const INVOICE_PATTERN = /(\d{3})\s*[.,]?\s*(\d{3})\s*[.,]?\s*(\d{3})/;

function meanScore(lines) {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.score, 0) / lines.length;
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

function findLabel(lines, key) {
  return lines.find((line) => compact(line.text).includes(key)) ?? null;
}

/**
 * The candidate nearest to a label, inside the field it names: below the
 * label, within a few label heights, and in the label's column. A full DANFE
 * under the stub has dates of its own, and none of them is the receiving one.
 */
function nearestBelow(label, candidates, maxHeights = 6) {
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (candidate === label) continue;
    if (candidate.cy < label.minY) continue;
    if (candidate.cy - label.cy > maxHeights * label.h) continue;
    if (
      candidate.cx < label.minX - 0.4 * label.w ||
      candidate.cx > label.maxX + 0.8 * label.w
    )
      continue;

    const dx = Math.max(
      0,
      label.minX - candidate.maxX,
      candidate.minX - label.maxX,
    );
    const dy = candidate.cy - label.cy;
    const distance = Math.hypot(dx, dy);

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/** A day/month that can exist (the product parses it again, strictly). */
function plausibleDate(text) {
  const match = String(text).match(DATE_PATTERN);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? match[0] : null;
}

function proofFromLines(rawLines) {
  const lines = rawLines.map(geometry);
  const all = lines.map((line) => compact(line.text)).join("|");

  const receiptHits = RECEIPT_KEYS.filter((key) => all.includes(key)).length;
  const notReceipt = NOT_RECEIPT_KEYS.some((key) => all.includes(key));

  const isReceipt =
    receiptHits >= 1 && !notReceipt
      ? "sim"
      : lines.length >= 3 || notReceipt
        ? "nao"
        : "nao_sei";

  // The invoice number: the 000.000.000 group (stub's "Nº", or the DANFE's).
  let number = null;
  for (const line of lines) {
    const text = normalize(line.text);
    if (/CHAVE|PROTOCOLO|CNPJ|INSCRICAO/.test(text)) continue;
    const match = text.match(INVOICE_PATTERN);
    if (
      match &&
      !/\d/.test(
        text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 1,
        ),
      )
    ) {
      number = `${match[1]}${match[2]}${match[3]}`;
      break;
    }
  }

  // The receiving date: the date-like text nearest below the DATA DE
  // RECEBIMENTO label. The printed EMISSÃO date sits elsewhere and is never
  // taken (the product's own rule: "any date on the paper" is not enough).
  const dateLabel = findLabel(lines, "DATADERECEBIMENTO");
  const dateLines = lines.filter(
    (line) =>
      line !== dateLabel &&
      plausibleDate(line.text) &&
      !/EMISS|VALOR|R\$|SAIDA|ENTRADA/.test(normalize(line.text)),
  );
  let date = null;
  if (dateLabel) {
    const found = nearestBelow(dateLabel, dateLines);
    if (found) date = plausibleDate(found.text);
  } else if (!all.includes("DANFE")) {
    // Label lost to blur: a stub alone has one handwritten date, a line of
    // its own (the printed EMISSAO date sits inside the long RECEBEMOS line).
    const alone = dateLines.find((line) => compact(line.text).length <= 10);
    if (alone) date = plausibleDate(alone.text);
  }

  // The recipient's name: letters only, nearest below the signature label.
  const signerLabel =
    findLabel(lines, "ASSINATURADORECEBEDOR") ??
    findLabel(lines, "IDENTIFICACAOEASSINATURA");
  let name = null;
  if (signerLabel) {
    const candidates = lines.filter(
      (line) =>
        /[A-Za-z]{3,}/.test(line.text) &&
        !/\d/.test(line.text) &&
        !/DANFE|IDENTIFICACAO|EMITENTE|DOCUMENTO|SERIE/.test(
          normalize(line.text),
        ),
    );
    const found = nearestBelow(signerLabel, candidates);
    if (found) name = found.text.trim();
  }

  const quality = meanScore(lines);
  const legible =
    isReceipt === "sim" && number
      ? "sim"
      : lines.length < 3 || quality < 0.6
        ? "nao"
        : "nao_sei";

  return {
    e_canhoto: isReceipt,
    numero_documento_lido: number,
    data_recebimento_lida: date,
    // OCR does not see ink strokes: a signature is a vision question.
    tem_assinatura: "nao_sei",
    nome_recebedor_lido: name,
    legivel: legible,
    qualidade_foto: Number(quality.toFixed(3)),
    confianca: Number(quality.toFixed(3)),
    observacao: `OCR: ${lines.length} linhas`,
  };
}

// ---------------------------------------------------------------------------
// Odometer
// ---------------------------------------------------------------------------

/**
 * Digit runs, merging the drum odometer's one-digit boxes that sit on the
 * same row next to each other.
 */
/**
 * The usual OCR letter-for-digit swaps, applied only to a token that is
 * already mostly digits (an odometer field never holds letters).
 */
const DIGIT_SWAPS = {
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

function asDigits(text) {
  const trimmed = text.trim();
  if (!/^[0-9A-Za-z|]{5,7}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "").length;
  if (digits / trimmed.length < 0.6) return trimmed;
  return [...trimmed].map((char) => DIGIT_SWAPS[char] ?? char).join("");
}

function digitRuns(rawLines) {
  const lines = rawLines.map((line) => ({
    ...line,
    text: asDigits(line.text),
  }));
  // "100 120": two dial labels the detector boxed together, not a reading.
  const numeric = lines.filter(
    (line) =>
      /^\s*\d[\d\s]*$/.test(line.text) && !/\d{2,}\s+\d{2,}/.test(line.text),
  );
  const runs = numeric.map((line) => ({
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
  const used = new Set();
  for (const start of singles) {
    if (used.has(start)) continue;
    const run = [start];
    used.add(start);
    let last = start;
    for (const next of singles) {
      if (used.has(next)) continue;
      const sameRow =
        Math.abs(next.cy - last.cy) < 0.4 * Math.max(next.h, last.h);
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

function odometerFromLines(rawLines) {
  const lines = rawLines.map(geometry);
  const all = lines.map((line) => compact(line.text)).join("|");
  const hasContext = /ODO|KM|TRIP/.test(all);

  const runs = digitRuns(lines).filter((run) =>
    run.text.length >= 5 && run.text.length <= 7
      ? true
      : run.text.length === 4 && hasContext,
  );

  let chosen = null;
  const odoLabel = lines.find(
    (line) =>
      compact(line.text) === "ODO" || compact(line.text).startsWith("ODO"),
  );

  if (odoLabel && runs.length > 0) {
    const label = geometry(odoLabel);
    chosen =
      runs
        .filter((run) => run.cy >= label.minY - label.h)
        .sort(
          (a, b) =>
            Math.hypot(a.cx - label.cx, a.cy - label.cy) -
            Math.hypot(b.cx - label.cx, b.cy - label.cy),
        )[0] ?? null;
  }

  // No ODO label: the tallest single-line run, then the longest.
  chosen ??=
    runs.sort(
      (a, b) =>
        Number(a.merged) - Number(b.merged) ||
        b.h - a.h ||
        b.text.length - a.text.length,
    )[0] ?? null;

  return {
    valor_lido: chosen ? Number(chosen.text) : null,
    confianca: Number((chosen?.score ?? 0).toFixed(3)),
    legivel: Boolean(chosen),
    // OCR cannot judge a photo of a screen or an edited picture.
    sinais_fraude: false,
    motivos_fraude: [],
    observacao: `OCR: ${lines.length} linhas, ${runs.length} candidatos`,
  };
}

// ---------------------------------------------------------------------------

/**
 * The product-shaped answer for one dataset item, and whether OCR covers the
 * question at all (fuel gauge, tyre, windshield, extinguisher: it does not).
 */
function answerFromOcr(item, kind, lines) {
  if (item.task === "proof")
    return { answer: proofFromLines(lines), covered: true };
  if (kind === "odometer")
    return { answer: odometerFromLines(lines), covered: true };

  if (kind === "fuel_level") {
    return {
      answer: {
        nivel_estimado: "ilegivel",
        confianca: 0,
        observacao: "OCR não cobre",
      },
      covered: false,
    };
  }
  if (kind === "condition") {
    return {
      answer: {
        condicao_observada: "nao_sei",
        confianca: 0,
        observacao: "OCR não cobre",
      },
      covered: false,
    };
  }

  return {
    answer: { item_ok: "nao_sei", confianca: 0, observacao: "OCR não cobre" },
    covered: false,
  };
}

export { answerFromOcr, odometerFromLines, proofFromLines };
