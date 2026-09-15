/**
 * What a machine can honestly say about a photo of a receipt, and what it
 * cannot.
 *
 * The audit that produced this slice recorded the reason it exists: an AI
 * verdict with no human behind it does not close a probative cycle. So nothing
 * here APPROVES anything. It reads four things off the photo, says how sure it
 * is, and produces a SUGGESTION — a card in a queue, ordered so the least
 * certain readings reach a person first.
 *
 * Pure, because "when does a receipt look wrong" is a product decision, and a
 * product decision that needs a model to test is a product decision nobody
 * tests.
 */

/** What the model is asked, one question at a time. */
type ProofCriterion =
  | "legible"
  | "hasSignature"
  | "dateVisible"
  | "documentMatches";

/**
 * Three answers, not two.
 *
 * "Não consigo dizer" is a real answer about a photo taken through a truck
 * window in the rain, and collapsing it into "no" would reject receipts that
 * are fine — which is worse than it sounds, because a rejection sends a driver
 * back to an address.
 */
type CriterionVerdict = "yes" | "no" | "unknown";

interface ProofCriteriaReading {
  legible: CriterionVerdict;
  hasSignature: CriterionVerdict;
  dateVisible: CriterionVerdict;
  documentMatches: CriterionVerdict;

  /** 0–1, the model's own. */
  photoQuality: number;
  confidence: number;

  /** One sentence, in Portuguese, for the card. */
  observation: string;
}

type ProofSuggestion = "looks_good" | "needs_review" | "looks_wrong";

interface ProofAssessment {
  suggestion: ProofSuggestion;

  /** The criteria that came back "no", in the order a person should read them. */
  failed: ProofCriterion[];

  /** The ones the model could not answer. */
  uncertain: ProofCriterion[];

  /** Ordering key for the queue: lower means "a person adds more here". */
  reviewPriority: number;
}

/** Read in this order on the card: the most damning first. */
const CRITERIA_ORDER: ProofCriterion[] = [
  "legible",
  "hasSignature",
  "documentMatches",
  "dateVisible",
];

const CRITERION_LABELS: Record<ProofCriterion, string> = {
  legible: "É um comprovante legível",
  hasSignature: "Tem assinatura",
  documentMatches: "O número do documento confere",
  dateVisible: "A data está presente",
};

/**
 * A photo too poor to read is not a failed receipt — it is a failed photo.
 *
 * Below this the model's answers are noise, and presenting them as findings
 * would have a person rejecting a delivery because of a camera.
 */
const UNUSABLE_PHOTO_QUALITY = 0.3;

/**
 * Where the model stops being worth believing on its own.
 *
 * Above it a clean reading is offered as "looks_good" and a reviewer can move
 * fast; below it everything goes to "needs_review" no matter how clean it
 * looked, because a confident-sounding wrong answer is the expensive kind.
 */
const TRUSTWORTHY_CONFIDENCE = 0.75;

function assessProof(reading: ProofCriteriaReading): ProofAssessment {
  const failed = CRITERIA_ORDER.filter(
    (criterion) => reading[criterion] === "no",
  );

  const uncertain = CRITERIA_ORDER.filter(
    (criterion) => reading[criterion] === "unknown",
  );

  // A photo nobody can read tells us nothing about the receipt in it. It still
  // has to reach a person — they may recognise the address from the corner of
  // the image, or know the driver phoned it in.
  if (reading.photoQuality < UNUSABLE_PHOTO_QUALITY) {
    return {
      suggestion: "needs_review",
      failed: [],
      uncertain: CRITERIA_ORDER,

      // First in the queue: a bad photo caught today can be retaken; caught
      // next week it cannot.
      reviewPriority: 0,
    };
  }

  // Illegible is the one criterion that makes the others meaningless: a model
  // that cannot read the page cannot have checked a number on it.
  if (reading.legible === "no") {
    return {
      suggestion: "looks_wrong",
      failed: ["legible"],
      uncertain: CRITERIA_ORDER.filter((criterion) => criterion !== "legible"),
      reviewPriority: 1,
    };
  }

  if (failed.length > 0) {
    return {
      suggestion: "looks_wrong",
      failed,
      uncertain,

      // The more that failed, the more likely it is a real problem rather than
      // a reading error.
      reviewPriority: Math.max(1, 4 - failed.length),
    };
  }

  if (uncertain.length > 0 || reading.confidence < TRUSTWORTHY_CONFIDENCE) {
    return {
      suggestion: "needs_review",
      failed: [],
      uncertain,

      // Least certain first: that is where a person adds the most.
      reviewPriority: 2 + reading.confidence,
    };
  }

  return {
    suggestion: "looks_good",
    failed: [],
    uncertain: [],

    // Last: a clean, confident reading is what a reviewer clears in a second,
    // and it should not sit in front of the ones that need thinking about.
    reviewPriority: 10,
  };
}

/** The sentence the queue card leads with, when the model produced one. */
function describeAssessment(assessment: ProofAssessment): string {
  if (assessment.suggestion === "looks_good") {
    return "Nada fora do lugar nos quatro critérios.";
  }

  if (assessment.failed.length > 0) {
    return `Problema em: ${assessment.failed
      .map((criterion) => CRITERION_LABELS[criterion].toLowerCase())
      .join("; ")}.`;
  }

  if (assessment.uncertain.length === CRITERIA_ORDER.length) {
    return "A foto está ruim demais para qualquer leitura automática.";
  }

  return `Não foi possível concluir: ${assessment.uncertain
    .map((criterion) => CRITERION_LABELS[criterion].toLowerCase())
    .join("; ")}.`;
}

export {
  CRITERIA_ORDER,
  CRITERION_LABELS,
  TRUSTWORTHY_CONFIDENCE,
  UNUSABLE_PHOTO_QUALITY,
  assessProof,
  describeAssessment,
};
export type {
  CriterionVerdict,
  ProofAssessment,
  ProofCriteriaReading,
  ProofCriterion,
  ProofSuggestion,
};
