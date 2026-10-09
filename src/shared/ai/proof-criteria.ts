/**
 * What a machine can honestly say about a photo of a receipt, and what it
 * cannot.
 *
 * The audit that produced this slice recorded the reason it exists: an AI
 * verdict with no human behind it does not close a probative cycle. So nothing
 * here APPROVES anything. It reads the photo, compares what it read with what
 * the delivery expects, says how sure it is, and produces a SUGGESTION — a
 * card in a queue, ordered so the least certain readings reach a person first.
 *
 * Pure, because "when does a receipt look wrong" is a product decision, and a
 * product decision that needs a model to test is a product decision nobody
 * tests.
 */

/** What is checked about the photo, one question at a time. */
type ProofCriterion =
  | "isReceipt"
  | "legible"
  | "hasSignature"
  | "dateVisible"
  | "documentMatches";

/**
 * Three answers, not two — plus "nothing to compare".
 *
 * "Não consigo dizer" is a real answer about a photo taken through a truck
 * window in the rain, and collapsing it into "no" would reject receipts that
 * are fine — which is worse than it sounds, because a rejection sends a driver
 * back to an address. `not_applicable` is a delivery with no invoice number:
 * there is no number to compare, which is neither doubt nor a failure.
 */
type CriterionVerdict = "yes" | "no" | "unknown" | "not_applicable";

/** What the model transcribed (decision 6.9), shown next to what was expected. */
interface ProofExtractedValues {
  /** The NF-e number read, digits only. */
  documentNumber: string | null;

  /** The receiving date as written, and as a day when it could be read as one. */
  receiptDateText: string | null;
  receiptDate: string | null;

  recipientName: string | null;

  /** A signature on the paper, as the model saw it. */
  signatureOnPaper: CriterionVerdict;

  /** The driver collected an on-screen signature with the proof. */
  digitalSignature: boolean;

  /**
   * False when the reader cannot see signatures (OCR, ADR 0010): the
   * signature is then "for you to check", never a tick. Absent = assessed.
   */
  signatureAssessed?: boolean;
}

/** What the delivery expected when it was proven. */
interface ProofExpectedValues {
  documentNumber: string | null;
  provenOn: string;
  recipientName: string | null;
}

interface ProofCriteriaReading {
  /** Absent on readings stored before decision 6.9 asked it. */
  isReceipt?: CriterionVerdict;
  legible: CriterionVerdict;
  hasSignature: CriterionVerdict;
  dateVisible: CriterionVerdict;
  documentMatches: CriterionVerdict;

  /** 0–1, the model's own. */
  photoQuality: number;
  confidence: number;

  /** One sentence, in Portuguese, for the card. */
  observation: string;

  extracted?: ProofExtractedValues;
  expected?: ProofExpectedValues;
}

type ProofSuggestion = "looks_good" | "needs_review" | "looks_wrong";

interface ProofAssessment {
  suggestion: ProofSuggestion;

  /** The criteria that came back "no", in the order a person should read them. */
  failed: ProofCriterion[];

  /** The ones that could not be answered. */
  uncertain: ProofCriterion[];

  /** Ordering key for the queue: lower means "a person adds more here". */
  reviewPriority: number;
}

/** Read in this order on the card: the most damning first. */
const CRITERIA_ORDER: ProofCriterion[] = [
  "isReceipt",
  "legible",
  "hasSignature",
  "documentMatches",
  "dateVisible",
];

/** The question, as a check a person ticks: the audit card's rows. */
const CRITERION_LABELS: Record<ProofCriterion, string> = {
  isReceipt: "É um canhoto de entrega",
  legible: "É um comprovante legível",
  hasSignature: "Tem assinatura",
  documentMatches: "O número da NF-e confere",
  dateVisible: "A data de recebimento é a da entrega",
};

/**
 * What is wrong when a criterion came back "no", said as the problem.
 *
 * The labels above are the positive question; listing them after "apontou:"
 * told a driver whose photo was not a receipt that it "é um canhoto de
 * entrega". Written in lower case already (they follow a colon), so no
 * transformation mangles "NF-e".
 */
const CRITERION_PROBLEMS: Record<ProofCriterion, string> = {
  isReceipt: "a foto não parece um canhoto de entrega",
  legible: "o canhoto está ilegível na foto",
  hasSignature: "não foi encontrada assinatura",
  documentMatches: "o número da NF-e lido não é o desta entrega",
  dateVisible: "a data de recebimento está em branco ou não é a da entrega",
};

/** What could not be confirmed when a criterion came back "unknown". */
const CRITERION_DOUBTS: Record<ProofCriterion, string> = {
  isReceipt: "se é um canhoto de entrega",
  legible: "se o comprovante está legível",
  hasSignature: "se há assinatura",
  documentMatches: "se o número da NF-e confere",
  dateVisible: "se a data de recebimento é a da entrega",
};

/** "a", "a e b", "a, b e c". */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");

  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/** The failed criteria as problems, most damning first (driver and card). */
function describeProblems(failed: ProofCriterion[]): string[] {
  return failed.map((criterion) => CRITERION_PROBLEMS[criterion] ?? criterion);
}

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
  // A photo the model says is not a receipt at all (a selfie, a box label, a
  // blank sheet) is the clearest wrong proof there is, and the one the driver
  // can still fix while at the address: first in the queue, whatever the
  // quality of the picture.
  if (reading.isReceipt === "no") {
    return {
      suggestion: "looks_wrong",
      failed: ["isReceipt"],
      uncertain: CRITERIA_ORDER.filter(
        (criterion) =>
          criterion !== "isReceipt" && reading[criterion] === "unknown",
      ),
      reviewPriority: 0,
    };
  }

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
      uncertain: CRITERIA_ORDER.filter(
        (criterion) =>
          criterion !== "legible" &&
          criterion !== "isReceipt" &&
          reading[criterion] !== "not_applicable",
      ),
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

/** What the driver hears when the photo itself could not be read. */
const UNUSABLE_PHOTO_PROBLEM = "a foto está ruim demais para leitura";

/** What the driver who sent a receipt is told about its reading. */
interface ProofDriverFeedback {
  /** Phrases said as problems, lower case (the push's "apontou: …"). */
  problems: string[];

  /** The card's sentence (describeAssessment). */
  summary: string;
}

/**
 * Whether the driver hears about the reading at all, and what (decision 6.9).
 *
 * Two readings are worth a push: a receipt that looks wrong, and a photo too
 * poor to read — the one the driver can still retake while at the address,
 * and the one a reviewer can do nothing with next week. A doubt about one
 * criterion, or a model unsure of itself, is the office's to settle: telling
 * the driver would send them looking for a problem nobody found.
 */
function driverFeedbackFor(
  reading: Pick<ProofCriteriaReading, "photoQuality"> | null | undefined,
  assessment: ProofAssessment,
): ProofDriverFeedback | null {
  if (assessment.suggestion === "looks_wrong") {
    return {
      problems: describeProblems(assessment.failed),
      summary: describeAssessment(assessment),
    };
  }

  if (
    assessment.suggestion === "needs_review" &&
    typeof reading?.photoQuality === "number" &&
    reading.photoQuality < UNUSABLE_PHOTO_QUALITY
  ) {
    return {
      problems: [UNUSABLE_PHOTO_PROBLEM],
      summary: describeAssessment(assessment),
    };
  }

  return null;
}

/** The sentence the queue card leads with, when the model produced one. */
function describeAssessment(assessment: ProofAssessment): string {
  if (assessment.suggestion === "looks_good") {
    return "Nada fora do lugar nos critérios verificados.";
  }

  if (assessment.failed.length > 0) {
    return `Possível problema: ${describeProblems(assessment.failed).join("; ")}.`;
  }

  if (assessment.uncertain.length === CRITERIA_ORDER.length) {
    return "A foto está ruim demais para qualquer leitura automática.";
  }

  // Every criterion answered, but the model was not sure of itself: an empty
  // list here used to render "Não foi possível concluir: .".
  if (assessment.uncertain.length === 0) {
    return "A leitura automática não teve confiança suficiente para sugerir.";
  }

  return `Não foi possível confirmar ${joinWithAnd(
    assessment.uncertain.map(
      (criterion) => CRITERION_DOUBTS[criterion] ?? criterion,
    ),
  )}.`;
}

export {
  CRITERIA_ORDER,
  CRITERION_DOUBTS,
  CRITERION_LABELS,
  CRITERION_PROBLEMS,
  TRUSTWORTHY_CONFIDENCE,
  UNUSABLE_PHOTO_PROBLEM,
  UNUSABLE_PHOTO_QUALITY,
  assessProof,
  describeAssessment,
  describeProblems,
  driverFeedbackFor,
};
export type {
  CriterionVerdict,
  ProofAssessment,
  ProofDriverFeedback,
  ProofCriteriaReading,
  ProofCriterion,
  ProofExpectedValues,
  ProofExtractedValues,
  ProofSuggestion,
};
