import { describe, expect, it } from "vitest";

import {
  CRITERIA_ORDER,
  CRITERION_LABELS,
  assessProof,
  describeAssessment,
  describeProblems,
  driverFeedbackFor,
  type ProofCriteriaReading,
} from "@/shared/ai/proof-criteria";

/**
 * What the machine is allowed to conclude about a photo of a receipt.
 *
 * The rule the whole thing is built on: nothing here approves anything. The
 * audit that produced this slice recorded why — an AI verdict with no human
 * behind it does not close a probative cycle. So every path leads to a card in
 * a queue, and the only thing being decided is which card a person sees first.
 *
 * The expensive mistake in both directions is worth naming. A false rejection
 * sends a driver back to an address for nothing. A false approval closes a
 * delivery whose proof will not hold when a customer disputes it months later.
 */
function reading(
  overrides: Partial<ProofCriteriaReading> = {},
): ProofCriteriaReading {
  return {
    isReceipt: "yes",
    legible: "yes",
    hasSignature: "yes",
    dateVisible: "yes",
    documentMatches: "yes",
    photoQuality: 0.9,
    confidence: 0.92,
    observation: "Canhoto legível, assinatura presente.",
    ...overrides,
  };
}

describe("a receipt that reads cleanly", () => {
  it("is suggested as fine, and sits at the back of the queue", () => {
    const assessment = assessProof(reading());

    expect(assessment.suggestion).toBe("looks_good");

    expect(assessment.failed).toEqual([]);
    expect(assessment.uncertain).toEqual([]);

    // Last on purpose: a clean, confident reading is cleared in a second and
    // must not sit in front of the ones that need thinking about.
    expect(assessment.reviewPriority).toBe(10);
  });

  it("still only SUGGESTS — there is no approval in here", () => {
    // The single most important assertion in this file.
    const suggestions = [
      assessProof(reading()).suggestion,
      assessProof(reading({ legible: "no" })).suggestion,
      assessProof(reading({ photoQuality: 0.1 })).suggestion,
    ];

    for (const suggestion of suggestions) {
      expect(["looks_good", "needs_review", "looks_wrong"]).toContain(
        suggestion,
      );
    }
  });
});

describe("a photo nobody can read", () => {
  it("goes to the front of the queue, with no findings against the receipt", () => {
    // A photo too poor to read is a failed PHOTO, not a failed receipt.
    // Presenting the model's guesses as findings would have somebody rejecting
    // a delivery because of a camera.
    const assessment = assessProof(
      reading({
        photoQuality: 0.1,
        legible: "no",
        hasSignature: "no",
        documentMatches: "no",
      }),
    );

    expect(assessment.suggestion).toBe("needs_review");
    expect(assessment.failed).toEqual([]);

    expect(assessment.uncertain).toEqual(CRITERIA_ORDER);

    // A bad photo caught today can be retaken; caught next week it cannot.
    expect(assessment.reviewPriority).toBe(0);
  });

  it("says so in words, rather than listing four failures", () => {
    const assessment = assessProof(reading({ photoQuality: 0.1 }));

    expect(describeAssessment(assessment)).toContain("foto está ruim");
  });
});

describe("an illegible page", () => {
  it("makes every other criterion meaningless", () => {
    // A model that cannot read the page cannot have checked a number on it,
    // and reporting "o número não confere" would be inventing a finding.
    const assessment = assessProof(
      reading({ legible: "no", documentMatches: "no", hasSignature: "no" }),
    );

    expect(assessment.failed).toEqual(["legible"]);

    expect(assessment.uncertain).toEqual([
      "hasSignature",
      "documentMatches",
      "dateVisible",
    ]);
  });
});

describe("a receipt with something wrong", () => {
  it("names what failed, worst first", () => {
    const assessment = assessProof(
      reading({ hasSignature: "no", dateVisible: "no" }),
    );

    expect(assessment.suggestion).toBe("looks_wrong");

    // The order the card reads them in: the most damning first.
    expect(assessment.failed).toEqual(["hasSignature", "dateVisible"]);
  });

  it("puts the ones with more failures earlier", () => {
    const one = assessProof(reading({ hasSignature: "no" }));

    const three = assessProof(
      reading({ hasSignature: "no", dateVisible: "no", documentMatches: "no" }),
    );

    expect(three.reviewPriority).toBeLessThan(one.reviewPriority);
  });

  // Red before: the positive label, lowercased whole — "Problema em: o
  // número da nf-e confere." said the number matched, and mangled "NF-e".
  it("says what failed as the problem, in a sentence a person reads", () => {
    const assessment = assessProof(reading({ documentMatches: "no" }));

    expect(describeAssessment(assessment)).toBe(
      "Possível problema: o número da NF-e lido não é o desta entrega.",
    );
  });

  it("names every failed criterion as its problem, worst first", () => {
    const assessment = assessProof(
      reading({ hasSignature: "no", documentMatches: "no", dateVisible: "no" }),
    );

    expect(describeProblems(assessment.failed)).toEqual([
      "não foi encontrada assinatura",
      "o número da NF-e lido não é o desta entrega",
      "a data de recebimento está em branco ou não é a da entrega",
    ]);

    for (const problem of describeProblems(CRITERIA_ORDER)) {
      // Never the positive question the card's checklist asks.
      expect(Object.values(CRITERION_LABELS)).not.toContain(problem);
      expect(problem).not.toMatch(/nf-e/);
    }
  });
});

/**
 * Decision 6.9: "é um canhoto?" comes first. The benchmark's uploads were a
 * meme, a box label with "NF 45181" and a blank sheet — each read as a fine
 * receipt by the old prompt, which never asked.
 */
describe("a photo that is not a receipt", () => {
  it("is wrong before anything else, and first in the queue", () => {
    const assessment = assessProof(
      reading({ isReceipt: "no", photoQuality: 0.95, confidence: 0.95 }),
    );

    expect(assessment.suggestion).toBe("looks_wrong");
    expect(assessment.failed).toEqual(["isReceipt"]);
    expect(assessment.reviewPriority).toBe(0);
    expect(describeAssessment(assessment)).toBe(
      "Possível problema: a foto não parece um canhoto de entrega.",
    );
  });

  it("is still wrong on a poor photo: the driver can retake it now", () => {
    expect(
      assessProof(reading({ isReceipt: "no", photoQuality: 0.1 })).suggestion,
    ).toBe("looks_wrong");
  });
});

describe("a delivery with no invoice number to compare", () => {
  it("is neither doubt nor failure", () => {
    const assessment = assessProof(reading({ documentMatches: "not_applicable" }));

    expect(assessment.suggestion).toBe("looks_good");
    expect(assessment.uncertain).toEqual([]);
  });
});

describe("a reading stored before the receipt question existed", () => {
  it("is assessed on the criteria it has", () => {
    const { isReceipt: _absent, ...legacy } = reading();

    expect(assessProof(legacy).suggestion).toBe("looks_good");
  });
});

describe("what the model is not sure about", () => {
  it("sends an uncertain reading to a person, however clean it looked", () => {
    // "I cannot tell" is a real answer about a photo taken through a truck
    // window in the rain. Collapsing it into "no" would reject receipts that
    // are fine — and a rejection sends a driver back to an address.
    const assessment = assessProof(reading({ dateVisible: "unknown" }));

    expect(assessment.suggestion).toBe("needs_review");

    expect(assessment.failed).toEqual([]);
    expect(assessment.uncertain).toEqual(["dateVisible"]);
  });

  it("says what could not be confirmed, in plain words", () => {
    expect(
      describeAssessment(
        assessProof(reading({ hasSignature: "unknown", documentMatches: "unknown" })),
      ),
    ).toBe(
      "Não foi possível confirmar se há assinatura e se o número da NF-e confere.",
    );
  });

  it("does not trust a clean reading the model was unsure of", () => {
    // A confident-sounding wrong answer is the expensive kind.
    const assessment = assessProof(reading({ confidence: 0.4 }));

    expect(assessment.suggestion).toBe("needs_review");

    // Red before: "Não foi possível concluir: ." — an empty list.
    expect(describeAssessment(assessment)).toBe(
      "A leitura automática não teve confiança suficiente para sugerir.",
    );
  });

  it("orders the least certain first", () => {
    const barely = assessProof(reading({ confidence: 0.2 }));
    const almost = assessProof(reading({ confidence: 0.7 }));

    expect(barely.reviewPriority).toBeLessThan(almost.reviewPriority);
  });

  it("puts every uncertain reading ahead of a clean one", () => {
    const unsure = assessProof(reading({ confidence: 0.74 }));
    const clean = assessProof(reading());

    expect(unsure.reviewPriority).toBeLessThan(clean.reviewPriority);
  });
});

describe("what the driver who sent it hears", () => {
  const feedback = (overrides: Partial<ProofCriteriaReading> = {}) => {
    const read = reading(overrides);
    return driverFeedbackFor(read, assessProof(read));
  };

  it("names the problems of a receipt that looks wrong", () => {
    expect(feedback({ hasSignature: "no" })).toEqual({
      problems: ["não foi encontrada assinatura"],
      summary: "Possível problema: não foi encontrada assinatura.",
    });
  });

  // Red before: only looks_wrong reached the driver, and the photo that can
  // still be retaken today — the one too poor to read — never did.
  it("tells them when the photo is too poor to read", () => {
    expect(feedback({ photoQuality: 0.1 })).toEqual({
      problems: ["a foto está ruim demais para leitura"],
      summary: "A foto está ruim demais para qualquer leitura automática.",
    });
  });

  it("stays quiet about a doubt, a model unsure of itself, and a clean receipt", () => {
    expect(feedback({ dateVisible: "unknown" })).toBeNull();
    expect(feedback({ confidence: 0.4 })).toBeNull();
    expect(feedback()).toBeNull();
  });
});
