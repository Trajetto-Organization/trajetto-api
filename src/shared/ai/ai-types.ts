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

interface AIAnalysisInputMap {
  FUEL_ODOMETER: FuelOdometerAnalysisInput;
  CHECKLIST: ChecklistAnalysisInput;
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
  AIAnalysisRequestInput,
  AnalysisUnitDescriptor,
  ChecklistAnalysisInput,
  ChecklistUnitResult,
  FuelOdometerAnalysisInput,
  OdometerUnitResult,
  ProviderCallUsage,
};
