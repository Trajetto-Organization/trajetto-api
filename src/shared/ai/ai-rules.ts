import { createHash } from "node:crypto";

import { AIAnalysisType } from "@prisma/client";

import {
  answerSchemas,
  type ConditionAnswer,
  type FuelLevelAnswer,
  type OdometerAnswer,
  type ProofAnswer,
  type WorkingAnswer,
} from "./ai-answers";
import { checklistFieldSpec } from "./ai-prompts";
import type { ReadingKind } from "./image-reader";
import type {
  CriterionVerdict,
  ProofCriteriaReading,
} from "./proof-criteria";

import {
  AIAnalysisInputMap,
  AnalysisUnitDescriptor,
  ChecklistAnalysisInput,
  ChecklistUnitResult,
  DeliveryProofAnalysisInput,
  OdometerUnitResult,
  PROOF_INPUT_VERSION,
} from "./ai-types";

/**
 * The pipeline's decision rules, kept pure so they can be unit-tested.
 * Quota math, unit derivation and result evaluation live here; I/O lives in
 * the quota/pipeline services.
 */

const ODOMETER_MISMATCH_THRESHOLD_KM = 50;

/** What an odometer read without a fraud check is, said as such. */
const FRAUD_NOT_ASSESSED_PREFIX = "Km lida confere com a informada";
const FRAUD_NOT_ASSESSED_NOTE =
  "A leitura automática não identifica foto de tela ou montagem.";
const ODOMETER_MISMATCH_THRESHOLD_PERCENT = 0.05;

/** The odometer unit key for FUEL_ODOMETER requests. */
const ODOMETER_UNIT_KEY = "odometer";

/** The single unit of a DELIVERY_PROOF request. */
const PROOF_UNIT_KEY = "proof";

// ============================================================================
// Lease budget
// ============================================================================

/**
 * How long a claimed request belongs to the replica that claimed it. Renewed
 * before every provider call, so it has to cover ONE unit, not a checklist.
 */
const AI_CLAIM_LEASE_SECONDS = 300;

/**
 * The longest a reader's client may wait between its own attempts. The local
 * OCR client makes none (LOCAL_AI_MAX_RETRIES = 0, the pipeline's backoff
 * does that); kept so a reader that retries is budgeted correctly.
 */
const AI_CLIENT_RETRY_WAIT_CEILING_MS = 60_000;

interface AILeaseBudget {
  providerTimeoutMs: number;
  providerMaxRetries: number;
  imageFetchTimeoutMs: number;
  leaseSeconds: number;
}

/**
 * One unit's worst case — fetch the photo, every client attempt timing out,
 * the longest wait between them — must end before its lease does. Otherwise
 * another replica re-claims the request while this one is still waiting on
 * the provider, and the same photo is paid for twice (INV-09). Same shape as
 * assertDeliveryLeaseInvariant, and asserted when the pipeline loads.
 */
function assertAILeaseInvariant({
  providerTimeoutMs,
  providerMaxRetries,
  imageFetchTimeoutMs,
  leaseSeconds,
}: AILeaseBudget): void {
  const worstCaseMs =
    imageFetchTimeoutMs +
    providerTimeoutMs * (providerMaxRetries + 1) +
    AI_CLIENT_RETRY_WAIT_CEILING_MS * providerMaxRetries;

  if (worstCaseMs >= leaseSeconds * 1000) {
    throw new Error(
      `AI lease invariant violated: one unit can take ${worstCaseMs}ms ` +
        `(fetch ${imageFetchTimeoutMs}ms, ${providerMaxRetries + 1} attempts ` +
        `of ${providerTimeoutMs}ms), which does not fit in the ` +
        `${leaseSeconds}s lease. Raise the lease or lower the timeouts.`,
    );
  }
}

// ============================================================================
// Quota
// ============================================================================

/**
 * How many of the requested units fit in the remaining quota. The SQL
 * reservation mirrors this exactly; the function exists so the rule is
 * testable. Partial grants are deliberate: with 2 units left, a 5-field
 * checklist still gets its 2 most important fields analyzed instead of
 * nothing — and the ledger can never overshoot the limit, which the legacy
 * check-then-increment counter did.
 */
function grantedUnits(
  requested: number,
  limit: number,
  reserved: number,
  consumed: number,
): number {
  return Math.max(0, Math.min(requested, limit - reserved - consumed));
}

// ============================================================================
// Units and idempotency
// ============================================================================

/** What the reader is asked to answer for one checklist field. */
function checklistReadingKind(
  fieldName: string,
  informed: unknown,
): ReadingKind {
  return checklistFieldSpec(fieldName, informed).kind;
}

/**
 * Derives the billable units from a request input. For checklists, fields
 * with no photo produce no unit, and `current_mileage` goes first so a
 * partial quota grant spends its units on the field with fraud potential
 * before cosmetic ones.
 *
 * `supports` is the reader's coverage (ADR 0010 §5): a photo the reader
 * cannot answer (fuel level, tyres, "working" items for OCR) creates NO unit,
 * so it reserves and consumes no quota. Without it every photo is a unit —
 * the pipeline rebuilds the full list to recognise the units of a request
 * queued under a reader that covered more.
 */
function buildAnalysisUnits<T extends AIAnalysisType>(
  type: T,
  input: AIAnalysisInputMap[T],
  supports: (kind: ReadingKind) => boolean = () => true,
): AnalysisUnitDescriptor[] {
  if (type === "FUEL_ODOMETER") {
    const fuelInput = input as AIAnalysisInputMap["FUEL_ODOMETER"];

    if (!fuelInput.odometerPhotoPath || !supports("odometer")) return [];

    return [
      {
        unitKey: ODOMETER_UNIT_KEY,
        photoPath: fuelInput.odometerPhotoPath,
        reportedValue: fuelInput.reportedMileage,
      },
    ];
  }

  if (type === "DELIVERY_PROOF") {
    const proofInput = input as AIAnalysisInputMap["DELIVERY_PROOF"];

    if (!proofInput.photoPath || !supports("proof")) return [];

    // One unit, one call: every question is about the same photo, and
    // charging a company several times to look at one picture would make the
    // feature cost several times what it is worth.
    return [
      {
        unitKey: PROOF_UNIT_KEY,
        photoPath: proofInput.photoPath,
        reportedValue: null,
      },
    ];
  }

  const checklistInput = input as AIAnalysisInputMap["CHECKLIST"];

  const fieldNames = Object.keys(checklistInput.photosByField).sort(
    (a, b) =>
      Number(b === "current_mileage") - Number(a === "current_mileage"),
  );

  const units: AnalysisUnitDescriptor[] = [];

  for (const fieldName of fieldNames) {
    const primaryPhoto = checklistInput.photosByField[fieldName]?.[0];
    if (!primaryPhoto) continue;

    const informed = checklistInput.checklistData?.[fieldName];
    if (!supports(checklistReadingKind(fieldName, informed))) continue;

    units.push({
      unitKey: fieldName,
      photoPath: primaryPhoto,
      reportedValue: informed,
    });
  }

  return units;
}

/**
 * JSON.stringify with recursively sorted object keys, so equal inputs hash
 * equal. A Date is its instant: `Object.entries(date)` is empty, so every
 * Date used to hash as `{}` and two different days were the same input.
 */
function stableStringify(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      );

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

/**
 * Same record + same input = same request: a usecase retry (mobile outbox
 * replays, crash-retry) never duplicates a job or a charge. A genuinely new
 * input — photo replaced, mileage edited — hashes differently and gets its
 * own request.
 */
function computeIdempotencyKey(
  type: AIAnalysisType,
  recordId: string,
  input: unknown,
): string {
  const hash = createHash("sha256")
    .update(stableStringify(input))
    .digest("hex")
    .slice(0, 32);

  return `${type}:${recordId}:${hash}`;
}

/** Only what a checklist reading depends on: a value is JSON, not a row. */
function informedValueOf(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return undefined;
}

/**
 * The checklist input as it is hashed and stored: the photographed fields and
 * their informed values, nothing else (AI-2).
 *
 * The manual "Verificar com IA" used to send the whole database row as
 * `checklistData` — ai_verification_status and _details included — so the
 * key changed the moment an analysis finished and the next click opened a new
 * request that paid for every photo again. The same projection is applied to
 * every caller (create, update, manual), so the same photos with the same
 * answers are the same request wherever they come from.
 */
function projectChecklistInput(
  input: ChecklistAnalysisInput,
): ChecklistAnalysisInput {
  const photosByField: Record<string, string[]> = {};
  const checklistData: Record<string, unknown> = {};

  for (const [field, photos] of Object.entries(input.photosByField ?? {})) {
    if (!Array.isArray(photos) || photos.length === 0) continue;

    photosByField[field] = photos;

    const value = informedValueOf(input.checklistData?.[field]);
    if (value !== undefined) checklistData[field] = value;
  }

  return { photosByField, checklistData };
}

// ============================================================================
// Odometer
// ============================================================================

interface MileageComparison {
  diff: number;
  mismatch: boolean;
}

/**
 * A divergence only counts as a mismatch when it exceeds both the absolute
 * and the relative threshold — the legacy service's rule.
 */
function compareMileage(read: number, reported: number): MileageComparison {
  const diff = Math.abs(read - reported);
  const percentDiff = reported > 0 ? diff / reported : diff;

  return {
    diff,
    mismatch:
      diff > ODOMETER_MISMATCH_THRESHOLD_KM &&
      percentDiff > ODOMETER_MISMATCH_THRESHOLD_PERCENT,
  };
}

/**
 * Whether the km the server read matches the km informed, by the same rule
 * as the verdict; null when nothing was read or nothing numeric informed.
 * The server's side of the device pre-check's agreement (design §P5.2).
 */
function odometerReadingMatches(read: unknown, informed: unknown): boolean | null {
  if (typeof read !== "number" || typeof informed !== "number") return null;

  return !compareMileage(read, informed).mismatch;
}

/**
 * The odometer verdict, from a BLIND reading compared here with what the
 * driver informed. The model never sees the informed mileage (ADR 0010: it
 * copied it back as its reading, even on photos that were not odometers).
 */
function evaluateOdometerReading(
  answer: OdometerAnswer,
  reportedMileage: number,
): OdometerUnitResult {
  const base = {
    reportedMileage,
    confidence: answer.confianca,
    observation: answer.observacao,
    fraudReasons: answer.motivos_fraude,
    ...(answer.fraude_avaliada === false ? { fraudAssessed: false } : {}),
    rawResponse: answer,
  };

  if (!answer.legivel || answer.valor_lido === null) {
    return {
      ...base,
      status: "unreadable",
      readMileage: null,
      details: answer.observacao || "Odômetro ilegível na imagem",
    };
  }

  if (answer.sinais_fraude) {
    const reasons = answer.motivos_fraude.join(", ");

    return {
      ...base,
      status: "fraud",
      readMileage: answer.valor_lido,
      details: `Suspeita de fraude${reasons ? `: ${reasons}` : ""}. ${answer.observacao}`.trim(),
    };
  }

  const { diff, mismatch } = compareMileage(answer.valor_lido, reportedMileage);

  if (mismatch) {
    return {
      ...base,
      status: "mismatch",
      readMileage: answer.valor_lido,
      details: `Divergência: IA leu ${answer.valor_lido} km, informado ${reportedMileage} km (diferença de ${diff.toFixed(0)} km). ${answer.observacao}`.trim(),
    };
  }

  // A reader that cannot judge fraud (OCR) only knows the numbers agree: a
  // photo of a screen reads exactly like a dashboard (benchmark O09). The
  // status stays "verified" — the km matches — and the record's seal stays
  // off (ai-record-store.ts); the sentence says what was not checked.
  if (answer.fraude_avaliada === false) {
    return {
      ...base,
      status: "verified",
      readMileage: answer.valor_lido,
      details: `${FRAUD_NOT_ASSESSED_PREFIX} (${answer.valor_lido} km; informado: ${reportedMileage} km). ${FRAUD_NOT_ASSESSED_NOTE}`,
    };
  }

  return {
    ...base,
    status: "verified",
    readMileage: answer.valor_lido,
    details: `Verificado: ${answer.valor_lido} km (informado: ${reportedMileage} km). ${answer.observacao}`.trim(),
  };
}

// ============================================================================
// Checklist
// ============================================================================

type ChecklistReading =
  | { kind: "odometer"; answer: OdometerAnswer }
  | { kind: "fuel_level"; answer: FuelLevelAnswer }
  | { kind: "condition"; answer: ConditionAnswer }
  | { kind: "working"; answer: WorkingAnswer };

/** "reserva" is the only level a driver should not leave the yard with. */
const INADEQUATE_FUEL_LEVELS = new Set(["reserva"]);

const CONDITION_GRADES = new Set(["good", "needs_attention", "bad"]);

function checklistResult(
  status: ChecklistUnitResult["status"],
  answer: { confianca: number; observacao: string; fraude_avaliada?: boolean },
  observed: string | number | null,
  informed: unknown,
  observation?: string,
): ChecklistUnitResult {
  return {
    status,
    confidence: answer.confianca,
    observation: observation ?? answer.observacao,
    observed,
    informed: informed ?? null,
    photosAnalyzed: 1,
    ...(answer.fraude_avaliada === false ? { fraudAssessed: false } : {}),
    rawResponse: answer,
  };
}

/**
 * One checklist item: what the model saw, compared here with what the driver
 * informed. Anything the photo could not settle is "inconclusive", never
 * "confirmed" (AI-14: a missing key used to read as agreement).
 */
function evaluateChecklistField(
  reading: ChecklistReading,
  informed: unknown,
): ChecklistUnitResult {
  if (reading.kind === "odometer") {
    const { answer } = reading;

    if (!answer.legivel || answer.valor_lido === null) {
      return checklistResult("inconclusive", answer, null, informed);
    }

    if (answer.sinais_fraude) {
      const reasons = answer.motivos_fraude.join(", ");

      return checklistResult(
        "contradicts",
        answer,
        answer.valor_lido,
        informed,
        `Suspeita de fraude${reasons ? `: ${reasons}` : ""}. ${answer.observacao}`.trim(),
      );
    }

    if (typeof informed !== "number") {
      return checklistResult("inconclusive", answer, answer.valor_lido, informed);
    }

    const { diff, mismatch } = compareMileage(answer.valor_lido, informed);

    if (mismatch) {
      return checklistResult(
        "contradicts",
        answer,
        answer.valor_lido,
        informed,
        `IA leu ${answer.valor_lido} km, informado ${informed} km (diferença de ${diff.toFixed(0)} km). ${answer.observacao}`.trim(),
      );
    }

    return checklistResult(
      "confirmed",
      answer,
      answer.valor_lido,
      informed,
      answer.fraude_avaliada === false
        ? `${FRAUD_NOT_ASSESSED_PREFIX}. ${FRAUD_NOT_ASSESSED_NOTE}`
        : undefined,
    );
  }

  if (reading.kind === "fuel_level") {
    const { answer } = reading;
    const level = answer.nivel_estimado;

    if (level === "ilegivel" || typeof informed !== "boolean") {
      return checklistResult("inconclusive", answer, level, informed);
    }

    const adequate = !INADEQUATE_FUEL_LEVELS.has(level);

    return checklistResult(
      adequate === informed ? "confirmed" : "contradicts",
      answer,
      level,
      informed,
    );
  }

  if (reading.kind === "condition") {
    const { answer } = reading;
    const observed = answer.condicao_observada;

    if (
      observed === "nao_sei" ||
      typeof informed !== "string" ||
      !CONDITION_GRADES.has(informed)
    ) {
      return checklistResult("inconclusive", answer, observed, informed);
    }

    // "needs_attention" against "bad" is a matter of degree, not a
    // contradiction: both say the item is not good. Saying "good" when the
    // photo shows otherwise — or the reverse — is.
    const sameSide = (informed === "good") === (observed === "good");

    return checklistResult(
      sameSide ? "confirmed" : "contradicts",
      answer,
      observed,
      informed,
    );
  }

  const { answer } = reading;

  if (answer.item_ok === "nao_sei" || typeof informed !== "boolean") {
    return checklistResult("inconclusive", answer, answer.item_ok, informed);
  }

  return checklistResult(
    (answer.item_ok === "sim") === informed ? "confirmed" : "contradicts",
    answer,
    answer.item_ok,
    informed,
  );
}

/**
 * A field's paid reading compared again with the value the checklist holds
 * NOW — no provider call. The reading is blind (ADR 0010): what the model saw
 * does not depend on what was informed, so an informed value edited after
 * the reading is judged by the same rule against the same answer. Null when
 * the stored answer is not in the shape this rule reads (a result stored by
 * an older prompt), which leaves the field's verdict as it was.
 */
function reassessChecklistField(
  fieldName: string,
  paidAnswer: unknown,
  informed: unknown,
): ChecklistUnitResult | null {
  const spec = checklistFieldSpec(fieldName, informed);
  const parsed = answerSchemas[spec.kind].safeParse(paidAnswer);

  if (!parsed.success) return null;

  return evaluateChecklistField(
    { kind: spec.kind, answer: parsed.data } as ChecklistReading,
    informedValueOf(informed) ?? null,
  );
}

// ============================================================================
// Delivery proof (decision 6.9)
// ============================================================================

function toVerdict(value: "sim" | "nao" | "nao_sei"): CriterionVerdict {
  if (value === "sim") return "yes";
  if (value === "nao") return "no";

  return "unknown";
}

/** An invoice number as digits, without the leading zeros a DANFE pads with. */
function invoiceDigits(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

/**
 * A handwritten receiving date ("27/09/2026", "27/09/26", "27.9") as
 * YYYY-MM-DD, or null when it cannot be read as a day. A missing year is the
 * delivery's year.
 */
function parseReceiptDate(
  text: string | null | undefined,
  provenOn: string,
): string | null {
  const match = String(text ?? "").match(
    /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : Number(provenOn.slice(0, 4));
  if (year < 100) year += 2000;

  // Rejects 31/02 and the like instead of rolling them into March. A
  // calendar key, no clock: the day as written.
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole days from `from` to `to`, both "YYYY-MM-DD". */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * How far before the proof the receiving date may be: a recipient who signs
 * at 23:55 and a driver who registers after midnight are one delivery.
 */
const RECEIPT_DATE_TOLERANCE_DAYS = 1;

/**
 * The criteria, decided in code from what the model TRANSCRIBED.
 *
 * - the number: the digits read against the delivery's NF-e — equal, different
 *   or, with nothing to compare, not applicable;
 * - the date: the receiving date read, as a day, against the day of the proof.
 *   "Any date on the paper" is not enough: the model reads the printed
 *   EMISSÃO date as readily as the handwritten one (benchmark P08, P09, P12);
 * - the signature: the on-screen signature the driver collected settles it;
 *   otherwise the model's reading of the paper.
 */
/**
 * Whether the input was built for decision 6.9 or later: its expected
 * document is the NF-e number. A later version keeps that meaning — an exact
 * match on 2 would silently stop comparing the day a field is added.
 */
function isCurrentProofInput(input: DeliveryProofAnalysisInput): boolean {
  return (input.inputVersion ?? 0) >= PROOF_INPUT_VERSION;
}

/**
 * The NF-e number (digits) a receipt is compared with, or "" when there is
 * none to trust.
 *
 * A request queued before decision 6.9 expected the delivery's CODE when it
 * had no invoice, and comparing with it called a good receipt "wrong NF-e".
 * Its expected document is trusted only when it IS the delivery's NF-e —
 * equal to the invoice number the delivery holds (`currentInvoiceNumber`);
 * dropping it always told the reviewer "Sem número para conferir" about a
 * delivery that had one.
 */
function expectedProofNumber(
  input: DeliveryProofAnalysisInput,
  currentInvoiceNumber?: string | null,
): string {
  const expected = invoiceDigits(input.expectedDocument);

  if (isCurrentProofInput(input)) return expected;

  return expected && expected === invoiceDigits(currentInvoiceNumber)
    ? expected
    : "";
}

function readProofExtraction(
  answer: ProofAnswer,
  input: DeliveryProofAnalysisInput,
  currentInvoiceNumber?: string | null,
): ProofCriteriaReading {
  const legible = toVerdict(answer.legivel);

  const readNumber = invoiceDigits(answer.numero_documento_lido);

  const expectedNumber = expectedProofNumber(input, currentInvoiceNumber);

  const documentMatches: CriterionVerdict = !expectedNumber
    ? "not_applicable"
    : !readNumber
      ? "unknown"
      : readNumber === expectedNumber
        ? "yes"
        : "no";

  const receiptDate = parseReceiptDate(
    answer.data_recebimento_lida,
    input.provenOn,
  );

  let dateVisible: CriterionVerdict;

  if (receiptDate) {
    const lag = daysBetween(receiptDate, input.provenOn);
    dateVisible = lag >= 0 && lag <= RECEIPT_DATE_TOLERANCE_DAYS ? "yes" : "no";
  } else if (answer.data_recebimento_lida && /\d/.test(answer.data_recebimento_lida)) {
    // Something date-like that is not a day: a person has to look.
    dateVisible = "unknown";
  } else {
    // A legible receipt with the field blank has no date; an unreadable one
    // might.
    dateVisible = legible === "yes" ? "no" : "unknown";
  }

  const signatureOnPaper = toVerdict(answer.tem_assinatura);
  const digitalSignature = Boolean(input.signaturePath);

  // A reader that cannot see ink (OCR) leaves the signature for a person,
  // even with an on-screen one: the receipt is then never "looks_good" on
  // the machine's word alone (ADR 0010 §3, item 3).
  const signatureAssessed = answer.assinatura_avaliada !== false;

  return {
    isReceipt: toVerdict(answer.e_canhoto),
    legible,
    hasSignature: !signatureAssessed
      ? "unknown"
      : digitalSignature
        ? "yes"
        : signatureOnPaper,
    dateVisible,
    documentMatches,

    photoQuality: answer.qualidade_foto,
    confidence: answer.confianca,
    observation: answer.observacao,

    extracted: {
      documentNumber: readNumber || null,
      receiptDateText: answer.data_recebimento_lida,
      receiptDate,
      recipientName: answer.nome_recebedor_lido,
      signatureOnPaper,
      digitalSignature,
      ...(signatureAssessed ? {} : { signatureAssessed: false }),
    },
    expected: {
      documentNumber: expectedNumber || null,
      provenOn: input.provenOn,
      recipientName: input.expectedRecipient || null,
    },
  };
}

// ============================================================================
// Results persisted before the 0–1 scale (AI-3)
// ============================================================================

/**
 * A stored confidence on the one scale: results written before this change
 * carry the model's 0–100.
 */
function unitConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(1, value > 1 ? value / 100 : value);
}

/**
 * An odometer result a unit already paid for, read back for a retry that
 * reuses it instead of calling the provider again — in the current shape,
 * whatever shape it was saved in.
 */
function restoreOdometerResult(
  stored: unknown,
  reportedMileage: number,
): OdometerUnitResult {
  const result = (stored ?? {}) as Partial<OdometerUnitResult> & {
    rawResponse?: { observacao?: unknown; motivos_fraude?: unknown };
  };

  const raw = result.rawResponse ?? {};

  return {
    status: result.status ?? "unreadable",
    readMileage: typeof result.readMileage === "number" ? result.readMileage : null,
    reportedMileage:
      typeof result.reportedMileage === "number"
        ? result.reportedMileage
        : reportedMileage,
    confidence: unitConfidence(result.confidence),
    details: typeof result.details === "string" ? result.details : "",
    observation:
      typeof result.observation === "string"
        ? result.observation
        : typeof raw.observacao === "string"
          ? raw.observacao
          : "",
    fraudReasons: Array.isArray(result.fraudReasons)
      ? result.fraudReasons
      : Array.isArray(raw.motivos_fraude)
        ? (raw.motivos_fraude as string[])
        : [],
    ...(result.fraudAssessed === false ? { fraudAssessed: false } : {}),
    rawResponse: result.rawResponse,
  };
}

// ============================================================================
// Checklist result aggregation
// ============================================================================

interface ChecklistFieldOutcome {
  status: string;
  confidence?: number;
  [key: string]: unknown;
}

/**
 * Merges this run's field results over what the record already has (an
 * update re-verifies only the changed fields; previous verdicts survive) and
 * recomputes the overall status across everything — the legacy consumer's
 * exact rule, extracted so it is testable.
 */
function mergeChecklistResults(
  existing: Record<string, ChecklistFieldOutcome>,
  fresh: Record<string, ChecklistFieldOutcome>,
): {
  merged: Record<string, ChecklistFieldOutcome>;
  overallStatus: "verified" | "issues_found" | "error";
} {
  const merged = { ...existing, ...fresh };
  const outcomes = Object.values(merged);

  const successfulAnalyses = outcomes.filter(
    (outcome) =>
      outcome.status !== "inconclusive" || (outcome.confidence ?? 0) > 0,
  ).length;

  const hasContradiction = outcomes.some(
    (outcome) => outcome.status === "contradicts",
  );

  return {
    merged,
    overallStatus:
      successfulAnalyses === 0
        ? "error"
        : hasContradiction
          ? "issues_found"
          : "verified",
  };
}

// ============================================================================
// Events
// ============================================================================

type AIRecordType = "fuel" | "checklist" | "proof";

/**
 * The record kind the screens know an analysis by. One map: the proof was
 * announced as "checklist" in two places (AI-7).
 */
function aiRecordTypeOf(type: AIAnalysisType): AIRecordType {
  if (type === "FUEL_ODOMETER") return "fuel";
  if (type === "DELIVERY_PROOF") return "proof";

  return "checklist";
}

export {
  AI_CLAIM_LEASE_SECONDS,
  FRAUD_NOT_ASSESSED_NOTE,
  FRAUD_NOT_ASSESSED_PREFIX,
  checklistReadingKind,
  expectedProofNumber,
  isCurrentProofInput,
  ODOMETER_UNIT_KEY,
  PROOF_UNIT_KEY,
  RECEIPT_DATE_TOLERANCE_DAYS,
  aiRecordTypeOf,
  assertAILeaseInvariant,
  buildAnalysisUnits,
  computeIdempotencyKey,
  evaluateChecklistField,
  evaluateOdometerReading,
  grantedUnits,
  invoiceDigits,
  mergeChecklistResults,
  odometerReadingMatches,
  parseReceiptDate,
  projectChecklistInput,
  readProofExtraction,
  reassessChecklistField,
  restoreOdometerResult,
  stableStringify,
  unitConfidence,
};

export type { AIRecordType, ChecklistFieldOutcome, ChecklistReading };
