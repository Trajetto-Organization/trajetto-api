/**
 * Turns a model answer into the verdict the product would store, then scores
 * it against the ground truth in labels.json.
 *
 * The rules are the product's own, loaded from source by product-source.mjs:
 * the answer is validated by the product's schema (parseModelAnswer), then
 * judged by evaluateOdometerReading, evaluateChecklistField and
 * readProofExtraction (ai-rules.ts) and assessProof (proof-criteria.ts). A
 * threshold, a comparison or a schema the product changes is the one the
 * next summary uses. An answer the product would refuse as invalid (AI-14)
 * scores as "invalid", never as a verdict.
 */
import { loadProductRules } from "./product-source.mjs";

const {
  PROOF_INPUT_VERSION,
  assessProof,
  checklistFieldSpec,
  evaluateChecklistField,
  evaluateOdometerReading,
  parseModelAnswer,
  readProofExtraction,
} = loadProductRules();

/** The product's validation of an answer, or null when it would refuse it. */
function validated(kind, parsed) {
  try {
    return parseModelAnswer(kind, JSON.stringify(parsed ?? null));
  } catch {
    return null;
  }
}

// --- scoring ----------------------------------------------------------------

const PROOF_CRITERIA = [
  "legible",
  "hasSignature",
  "dateVisible",
  "documentMatches",
];

function scoreOdometer(item, parsed) {
  const expected = item.truth.expected;
  const answer = validated("odometer", parsed);

  if (!answer) {
    return {
      status: "invalid",
      statusOk: false,
      readValue: parsed?.valor_lido ?? null,
      readExact: null,
      falseVerified: false,
      falseAlarm: expected.includes("verified"),
    };
  }

  const result = evaluateOdometerReading(answer, item.input.reportedMileage);

  return {
    status: result.status,
    statusOk: expected.includes(result.status),
    readValue: answer.valor_lido ?? null,
    readExact:
      item.truth.reading === null
        ? null
        : Number(answer.valor_lido) === item.truth.reading,
    // Fraud or a wrong number going through as "verified" is the costly miss.
    falseVerified:
      result.status === "verified" && !expected.includes("verified"),
    falseAlarm: expected.includes("verified") && result.status !== "verified",
  };
}

function scoreChecklist(item, parsed) {
  const { fieldName, fieldValue } = item.input;
  const spec = checklistFieldSpec(fieldName, fieldValue);
  const answer = validated(spec.kind, parsed);

  const result = answer
    ? evaluateChecklistField({ kind: spec.kind, answer }, fieldValue)
    : { status: "invalid" };

  const confirmed = result.status === "confirmed";
  const score = {
    status: result.status,
    ok: confirmed === item.truth.expectedMatch,
    // The product no longer defaults a missing key to "confirmed" (AI-14);
    // kept so the tables of earlier runs stay comparable.
    defaultedToConfirmed: false,
  };

  if (fieldName === "current_mileage" && item.truth.reading != null) {
    score.readExact = Number(answer?.valor_lido) === item.truth.reading;
  }
  if (fieldName === "fuel_level_adequate" && item.truth.level) {
    score.levelExact = answer?.nivel_estimado === item.truth.level;
  }
  if (fieldName === "tires_condition" && item.truth.condition) {
    score.conditionExact = answer?.condicao_observada === item.truth.condition;
  }

  return score;
}

function scoreProof(item, parsed) {
  const answer = validated("proof", parsed);

  const reading = answer
    ? readProofExtraction(answer, {
        photoPath: item.file,
        signaturePath: null,
        expectedDocument: item.input.expectedDocument ?? null,
        expectedRecipient: item.input.expectedRecipient ?? "",
        provenOn: item.input.provenOn,
        inputVersion: PROOF_INPUT_VERSION,
      })
    : null;

  const suggestion = reading ? assessProof(reading).suggestion : "invalid";

  const criteria = {};
  for (const criterion of PROOF_CRITERIA) {
    const truth = item.truth[criterion];
    if (truth === null || truth === undefined) continue;

    const answerOf = reading?.[criterion] ?? "invalid";
    criteria[criterion] = {
      truth,
      answer: answerOf,
      correct: answerOf === truth,
      abstained: answerOf === "unknown",
      // "No" on a receipt that is fine sends a driver back to the address.
      falseNo: truth === "yes" && answerOf === "no",
      falseYes: truth === "no" && answerOf === "yes",
    };
  }

  const expected = item.truth.expected;
  const suggestionOk =
    expected === "not_good"
      ? suggestion !== "looks_good"
      : suggestion === expected;

  return {
    suggestion,
    suggestionOk,
    criteria,
    isReceipt: reading?.isReceipt ?? null,
    isReceiptOk:
      item.truth.isReceipt === null ||
      item.truth.isReceipt === undefined ||
      !reading
        ? null
        : reading.isReceipt === item.truth.isReceipt,
    readNumber: reading?.extracted?.documentNumber ?? null,
    readDate: reading?.extracted?.receiptDate ?? null,
    numberExact:
      item.truth.printedNumber === null ||
      item.truth.printedNumber === undefined
        ? null
        : (reading?.extracted?.documentNumber ?? null) ===
          item.truth.printedNumber,
  };
}

function scoreItem(item, parsed) {
  if (item.task === "odometer") return scoreOdometer(item, parsed);
  if (item.task === "checklist") return scoreChecklist(item, parsed);
  return scoreProof(item, parsed);
}

export { PROOF_CRITERIA, scoreItem };
