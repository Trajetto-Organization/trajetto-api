import { createHash } from "node:crypto";

import { AIAnalysisType } from "@prisma/client";

import type {
  CriterionVerdict,
  ProofCriteriaReading,
} from "./proof-criteria";

import {
  AIAnalysisInputMap,
  AnalysisUnitDescriptor,
  ChecklistUnitResult,
  OdometerUnitResult,
} from "./ai-types";

/**
 * The pipeline's decision rules, kept pure so they can be unit-tested.
 * Quota math, unit derivation and result evaluation live here; I/O lives in
 * the quota/pipeline services.
 */

const ODOMETER_MISMATCH_THRESHOLD_KM = 50;
const ODOMETER_MISMATCH_THRESHOLD_PERCENT = 0.05;

/** The odometer unit key for FUEL_ODOMETER requests. */
const ODOMETER_UNIT_KEY = "odometer";

/** The single unit of a DELIVERY_PROOF request. */
const PROOF_UNIT_KEY = "proof";

// ============================================================================
// Billing period
// ============================================================================

/** First day of the calendar month `date` falls in (UTC date-only). */
function periodStartFor(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

/** When the next quota period begins — what the UI shows as the reset date. */
function nextPeriodStartFor(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}

/**
 * Whether a provider HTTP status means retrying is pointless. Client-side
 * failures (bad key, forbidden, malformed request) return the same answer on
 * every attempt — waiting through the backoff schedule only delays the error
 * the user needs to see. Rate limits (429), server errors (5xx) and network
 * failures (no status) are transient and keep the retry path.
 */
function isNonRetryableProviderStatus(status: number | undefined): boolean {
  if (status === undefined) return false;

  return status === 400 || status === 401 || status === 403 || status === 404;
}

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

/**
 * Derives the billable units from a request input. For checklists, fields
 * with no photo produce no unit, and `current_mileage` goes first so a
 * partial quota grant spends its units on the field with fraud potential
 * before cosmetic ones.
 */
function buildAnalysisUnits<T extends AIAnalysisType>(
  type: T,
  input: AIAnalysisInputMap[T],
): AnalysisUnitDescriptor[] {
  if (type === "FUEL_ODOMETER") {
    const fuelInput = input as AIAnalysisInputMap["FUEL_ODOMETER"];

    if (!fuelInput.odometerPhotoPath) return [];

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

    if (!proofInput.photoPath) return [];

    // One unit, one call. The four criteria are four questions in ONE prompt
    // rather than four requests: they are all about the same photo, and
    // charging a company four times to look at one picture would make the
    // feature cost four times what it is worth.
    return [
      {
        unitKey: PROOF_UNIT_KEY,
        photoPath: proofInput.photoPath,
        reportedValue: {
          expectedDocument: proofInput.expectedDocument,
          expectedRecipient: proofInput.expectedRecipient,
          provenOn: proofInput.provenOn,
        },
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

    units.push({
      unitKey: fieldName,
      photoPath: primaryPhoto,
      reportedValue: checklistInput.checklistData[fieldName],
    });
  }

  return units;
}

/** JSON.stringify with recursively sorted object keys, so equal inputs hash equal. */
function stableStringify(value: unknown): string {
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

// ============================================================================
// Provider response evaluation
// ============================================================================

interface OdometerProviderResponse {
  valor_lido?: number | null;
  confianca?: number;
  legivel?: boolean;
  sinais_fraude?: boolean;
  motivos_fraude?: string[];
  observacao?: string;
}

/**
 * Turns the model's parsed odometer reading into a verdict, applying the
 * same thresholds the legacy service used: a divergence only counts as a
 * mismatch when it exceeds both the absolute and the relative threshold.
 */
function evaluateOdometerReading(
  parsed: OdometerProviderResponse,
  reportedMileage: number,
): OdometerUnitResult {
  const confidence = parsed.confianca || 0;

  if (!parsed.legivel || parsed.valor_lido === null || parsed.valor_lido === undefined) {
    return {
      status: "unreadable",
      readMileage: null,
      confidence,
      details: parsed.observacao || "Odômetro ilegível na imagem",
      rawResponse: parsed,
    };
  }

  if (parsed.sinais_fraude) {
    return {
      status: "fraud",
      readMileage: parsed.valor_lido,
      confidence,
      details: `Suspeita de fraude: ${(parsed.motivos_fraude || []).join(", ")}. ${parsed.observacao || ""}`,
      rawResponse: parsed,
    };
  }

  const diff = Math.abs(parsed.valor_lido - reportedMileage);
  const percentDiff = reportedMileage > 0 ? diff / reportedMileage : diff;

  if (
    diff > ODOMETER_MISMATCH_THRESHOLD_KM &&
    percentDiff > ODOMETER_MISMATCH_THRESHOLD_PERCENT
  ) {
    return {
      status: "mismatch",
      readMileage: parsed.valor_lido,
      confidence,
      details: `Divergência: IA leu ${parsed.valor_lido} km, informado ${reportedMileage} km (diferença de ${diff.toFixed(0)} km). ${parsed.observacao || ""}`,
      rawResponse: parsed,
    };
  }

  return {
    status: "verified",
    readMileage: parsed.valor_lido,
    confidence,
    details: `Verificado: ${parsed.valor_lido} km (informado: ${reportedMileage} km). ${parsed.observacao || ""}`,
    rawResponse: parsed,
  };
}

interface ChecklistProviderResponse {
  corresponde_ao_informado?: boolean;
  corresponde?: boolean;
  confianca?: number;
  observacao?: string;
}

function evaluateChecklistField(
  parsed: ChecklistProviderResponse,
): ChecklistUnitResult {
  const matches = parsed.corresponde_ao_informado ?? parsed.corresponde ?? true;

  return {
    status: matches ? "confirmed" : "contradicts",
    confidence: parsed.confianca || 0,
    observation: parsed.observacao || "",
    rawResponse: parsed,
    photosAnalyzed: 1,
  };
}

// ============================================================================
// Delivery proof
// ============================================================================

/**
 * What the model answers about a receipt photo. Portuguese keys, like the
 * other two prompts: the model is asked in Portuguese and answers in it, and
 * translating the keys on the way in would be a mapping that can drift.
 */
interface ProofProviderResponse {
  legivel?: string;
  tem_assinatura?: string;
  data_presente?: string;
  documento_confere?: string;

  qualidade_foto?: number;
  confianca?: number;

  observacao?: string;
}

/**
 * "sim" / "nao" / anything else.
 *
 * Anything the model did not say clearly becomes "unknown" rather than "no",
 * and that default is the whole safety of this feature: an unparseable answer
 * read as a failure would reject a receipt that is fine, and a rejection sends
 * a driver back to an address.
 */
function toVerdict(value: string | undefined): CriterionVerdict {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized === "sim") return "yes";
  if (normalized === "nao" || normalized === "não") return "no";

  return "unknown";
}

/** Clamps a model-reported score into the range it promised. */
function toScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;

  return Math.min(1, Math.max(0, value));
}

function readProofResponse(
  parsed: ProofProviderResponse,
): ProofCriteriaReading {
  return {
    legible: toVerdict(parsed.legivel),
    hasSignature: toVerdict(parsed.tem_assinatura),
    dateVisible: toVerdict(parsed.data_presente),
    documentMatches: toVerdict(parsed.documento_confere),

    photoQuality: toScore(parsed.qualidade_foto),
    confidence: toScore(parsed.confianca),

    observation: parsed.observacao?.trim() || "",
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

export {
  ODOMETER_UNIT_KEY,
  PROOF_UNIT_KEY,
  readProofResponse,
  buildAnalysisUnits,
  computeIdempotencyKey,
  evaluateChecklistField,
  evaluateOdometerReading,
  grantedUnits,
  isNonRetryableProviderStatus,
  mergeChecklistResults,
  nextPeriodStartFor,
  periodStartFor,
  stableStringify,
};

export type {
  ChecklistFieldOutcome,
  ProofProviderResponse,
  ChecklistProviderResponse,
  OdometerProviderResponse,
};
