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

  /**
   * The informed values the readings are compared WITH, in code — only the
   * fields that have a photo (projectChecklistInput). A field whose value the
   * request does not carry is compared with the record's current value.
   */
  checklistData: Record<string, unknown>;
}

/**
 * The receipt photo a driver sent back, and what the delivery expects.
 *
 * The expected values travel with the request rather than being looked up at
 * analysis time, because the analysis runs minutes later and the delivery may
 * have been corrected in between. They are compared in code with what the
 * model transcribed; none of them is ever put in the prompt (decision 6.9).
 */
interface DeliveryProofAnalysisInput {
  photoPath: string;

  /** The on-screen signature, when the driver collected one. */
  signaturePath: string | null;

  /** The NF-e number the receipt should carry; null when it has none. */
  expectedDocument: string | null;
  expectedRecipient: string;

  /** The business day it was proven ("YYYY-MM-DD", company zone). */
  provenOn: string;

  /**
   * PROOF_INPUT_VERSION on inputs built for decision 6.9. Absent on requests
   * queued before it, whose `expectedDocument` fell back to the delivery's
   * own code — a number no receipt carries — so it is not compared.
   */
  inputVersion?: number;
}

/** The shape of DeliveryProofAnalysisInput whose expected number is the NF-e. */
const PROOF_INPUT_VERSION = 2;

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

/**
 * Stored in AIAnalysisUnit.result for FUEL_ODOMETER units and, without
 * `rawResponse`, in Fuel.odometer_ai_details — the key the screens read
 * (`confidence`, 0–1) instead of the model's raw answer (AI-3).
 */
interface OdometerUnitResult {
  status: "verified" | "mismatch" | "fraud" | "unreadable";
  readMileage: number | null;
  reportedMileage: number;

  /** 0–1, on every AI result (AI-3). */
  confidence: number;

  /** The sentence the screen shows. */
  details: string;

  /** The model's own words. */
  observation: string;
  fraudReasons: string[];

  /**
   * False when the reader could not judge fraud (OCR): "verified" then
   * means "the km matches", and the record's seal stays off. Absent on
   * results stored before 05/10/2026, which a model did judge.
   */
  fraudAssessed?: boolean;

  rawResponse?: unknown;
}

/**
 * Stored in AIAnalysisUnit.result for CHECKLIST units — the same shape the
 * record's ai_verification_details keeps per field, so merging is a spread.
 */
interface ChecklistUnitResult {
  status: "confirmed" | "contradicts" | "inconclusive";

  /** 0–1 (AI-3). */
  confidence: number;
  observation: string;

  /** What the model read (a km, a fuel level, a grade, sim/não). */
  observed: string | number | null;

  /** What the driver informed, as compared. */
  informed: unknown;

  photosAnalyzed: number;

  /** As on OdometerUnitResult: false when fraud was not judged (OCR). */
  fraudAssessed?: boolean;

  rawResponse?: unknown;
}

/**
 * One reader call, persisted on AIProviderAttempt. The local OCR has no
 * tokens (null) and names in `model` the engine, the profile and the version
 * of the rules that turned its lines into the answer, so an audit knows what
 * read each photo.
 */
interface ProviderCallUsage {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/** A validated answer and what the call cost. */
interface ProviderCall<TParsed> {
  parsed: TParsed;
  usage: ProviderCallUsage;
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
  ProviderCall,
  ProviderCallUsage,
};
export { PROOF_INPUT_VERSION };
