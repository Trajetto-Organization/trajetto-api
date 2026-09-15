import { AIAnalysisType } from "@prisma/client";

/**
 * Input payloads persisted on AIAnalysisRequest.input. They must stay
 * JSON-serializable: the pipeline rebuilds the work units from this persisted
 * value, never from in-memory state.
 */
interface FuelOdometerAnalysisInput {
  odometerPhotoPath: string;
  reportedMileage: number;
}

interface ChecklistAnalysisInput {
  /** Photo storage paths per checklist field; the first photo is analyzed. */
  photosByField: Record<string, string[]>;

  /** The reported values the photos are checked against. */
  checklistData: Record<string, unknown>;
}

/**
 * The receipt photo a driver sent back, and what it is supposed to show.
 *
 * The expected values travel with the request rather than being looked up at
 * analysis time, because the analysis runs minutes later and the delivery may
 * have been corrected in between — the model must be asked about the document
 * that was proven, not about the row as it stands now.
 */
interface DeliveryProofAnalysisInput {
  photoPath: string;
  signaturePath: string | null;

  /** What the receipt should carry, for the "confere" criterion. */
  expectedDocument: string | null;
  expectedRecipient: string;

  /** The day it was proven, for the "data presente" criterion. */
  provenOn: string;
}

interface AIAnalysisInputMap {
  FUEL_ODOMETER: FuelOdometerAnalysisInput;
  CHECKLIST: ChecklistAnalysisInput;
  DELIVERY_PROOF: DeliveryProofAnalysisInput;
}

type AIAnalysisRequestInput = {
  [T in AIAnalysisType]: {
    type: T;
    recordId: string;
    businessId: string;
    requestedById: string;
    input: AIAnalysisInputMap[T];
  };
}[AIAnalysisType];

/** One billable provider call, derived from the request input. */
interface AnalysisUnitDescriptor {
  unitKey: string;
  photoPath: string;

  /** Reported mileage (fuel) or the informed field value (checklist). */
  reportedValue: unknown;
}

/** Stored in AIAnalysisUnit.result for FUEL_ODOMETER units. */
interface OdometerUnitResult {
  status: "verified" | "mismatch" | "fraud" | "unreadable";
  readMileage: number | null;
  confidence: number;
  details: string;
  rawResponse: unknown;
}

/**
 * Stored in AIAnalysisUnit.result for CHECKLIST units — the same shape the
 * record's ai_verification_details keeps per field, so merging is a spread.
 */
interface ChecklistUnitResult {
  status: "confirmed" | "contradicts" | "inconclusive";
  confidence: number;
  observation: string;
  rawResponse: unknown;
  photosAnalyzed: number;
}

/** Token accounting for one provider call, persisted on AIProviderAttempt. */
interface ProviderCallUsage {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export type {
  AIAnalysisInputMap,
  DeliveryProofAnalysisInput,
  AIAnalysisRequestInput,
  AnalysisUnitDescriptor,
  ChecklistAnalysisInput,
  ChecklistUnitResult,
  FuelOdometerAnalysisInput,
  OdometerUnitResult,
  ProviderCallUsage,
};
