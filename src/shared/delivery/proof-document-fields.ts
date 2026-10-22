import { isValidCnpj } from "./cnpj";

/**
 * The small, pure decisions behind the fields of the validated proof model
 * (decision 14.8, docs/desenho/comprovante-modelo-validado-e-icp.md §3.1).
 *
 * Kept apart from the document builder so each rule is tested on its own:
 * a wrong document kind or an invented CNPJ on a legal document is the kind
 * of mistake nobody notices until it is read out in a dispute.
 */

type DocumentKind = "NFe" | "NFCe" | "CTe" | "NF" | "Pedido";

/**
 * NF-e access key layout (MOC NF-e): cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3)
 * nNF(9) tpEmis(1) cNF(8) cDV(1) — 44 digits. The model sits at positions
 * 21–22 and the issuer's CNPJ at 7–20 (1-based).
 */
const KEY_MODELS: Record<string, DocumentKind> = {
  "55": "NFe",
  "65": "NFCe",
  "57": "CTe",
};

function accessKeyDigits(key: string | null | undefined): string | null {
  const digits = (key ?? "").replace(/\D/g, "");

  return digits.length === 44 ? digits : null;
}

/**
 * What kind of document the delivery travels with, and its number.
 *
 * Without a readable key but with a number it is a generic "NF"; without
 * either it is the order, and the order code becomes the number printed.
 */
function documentKind(delivery: {
  invoice_key: string | null;
  invoice_number: string | null;
  code: string | null;
}): { kind: DocumentKind; number: string | null } {
  const number = delivery.invoice_number?.trim() || null;
  const key = accessKeyDigits(delivery.invoice_key);

  const fromKey = key ? KEY_MODELS[key.slice(20, 22)] : undefined;

  if (fromKey) return { kind: fromKey, number };
  if (number) return { kind: "NF", number };

  return { kind: "Pedido", number: delivery.code?.trim() || null };
}

/**
 * The issuer's CNPJ embedded in the access key — only when its check digits
 * hold. A key typed by hand can be off by one digit, and printing a CNPJ that
 * belongs to nobody (or to somebody else) is worse than "Não informado".
 */
function issuerCnpjFromKey(key: string | null | undefined): string | null {
  const digits = accessKeyDigits(key);

  if (!digits) return null;

  const cnpj = digits.slice(6, 20);

  return isValidCnpj(cnpj) ? cnpj : null;
}

/** The label of the recipient's document, by what it actually is. */
function recipientDocumentLabel(
  document: string | null | undefined,
): "CNPJ" | "CPF" | "Documento" {
  const digits = (document ?? "").replace(/\D/g, "");

  if (digits.length === 14) return "CNPJ";
  if (digits.length === 11) return "CPF";

  return "Documento";
}

/**
 * The recipient's document as printed: digits only for a CPF/CNPJ (as the
 * model prints them), the raw value otherwise. Unmasked on purpose: it is
 * the evidence of who received (ADR 0009 §1).
 */
function recipientDocumentValue(
  document: string | null | undefined,
): string | null {
  const raw = document?.trim();

  if (!raw) return null;

  const digits = raw.replace(/\D/g, "");

  return digits.length === 14 || digits.length === 11 ? digits : raw;
}

/** -20.35021 → "-20,3502": the comma the person holding the paper uses. */
function formatDecimalComma(value: number, places: number): string {
  return value.toFixed(places).replace(".", ",");
}

/** "14 digits" → "00.000.000/0000-00", for the authentication sentence. */
function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== 14) return value;

  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

/** "29106100" → "29106-100"; anything else as it came. */
function formatCep(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");

  if (!digits) return null;

  return digits.length === 8
    ? `${digits.slice(0, 5)}-${digits.slice(5)}`
    : digits;
}

interface StampInput {
  /** The brand that opens the line ("Trajetto"). */
  brand: string;

  /** "30/09/2026 13:30:08", already on the company's clock. */
  moment: string;

  latitude: number | null | undefined;
  longitude: number | null | undefined;

  driverName: string | null | undefined;

  kind: DocumentKind;
  number: string | null;
}

/**
 * The yellow line under the receipt photo, in the model's order:
 * `Trajetto - 30/09/2026 13:30:08  -20,3501, -40,3037  NOME  NFe 45515`.
 *
 * One line, never wrapped (the renderer cuts it with an ellipsis), so every
 * part is short and the separators are spaces, as in the model.
 */
function stampLine(input: StampInput): string {
  const hasGps =
    typeof input.latitude === "number" &&
    typeof input.longitude === "number" &&
    Number.isFinite(input.latitude) &&
    Number.isFinite(input.longitude);

  const place = hasGps
    ? `${formatDecimalComma(input.latitude as number, 4)}, ${formatDecimalComma(input.longitude as number, 4)}`
    : "GPS indisponível";

  const driver = input.driverName?.trim()
    ? input.driverName.trim().toLocaleUpperCase("pt-BR")
    : null;

  const document = input.number ? `${input.kind} ${input.number}` : input.kind;

  return [`${input.brand} - ${input.moment}`, place, driver, document]
    .filter((part): part is string => Boolean(part))
    .join("  ");
}

export {
  documentKind,
  formatCep,
  formatCnpj,
  formatDecimalComma,
  issuerCnpjFromKey,
  recipientDocumentLabel,
  recipientDocumentValue,
  stampLine,
};
export type { DocumentKind, StampInput };
