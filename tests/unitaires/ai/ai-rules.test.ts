import { describe, expect, it } from "vitest";

import {
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
} from "@/shared/ai/ai-rules";

describe("billing period", () => {
  it("anchors the period to the first day of the month (UTC)", () => {
    const period = periodStartFor(new Date("2026-08-15T18:30:00Z"));

    expect(period.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rolls the reset date into the next month, across years", () => {
    expect(
      nextPeriodStartFor(new Date("2026-12-31T23:59:59Z")).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("quota grants", () => {
  it("grants everything when the quota fits", () => {
    expect(grantedUnits(3, 100, 10, 20)).toBe(3);
  });

  /**
   * Partial grants are the point: with 2 units left, a 5-field checklist
   * still gets its 2 most important fields analyzed — and the ledger can
   * never overshoot the limit the way the legacy counter could.
   */
  it("grants only what remains", () => {
    expect(grantedUnits(5, 10, 3, 5)).toBe(2);
  });

  it("denies when the limit is exhausted or disabled", () => {
    expect(grantedUnits(1, 10, 0, 10)).toBe(0);
    expect(grantedUnits(1, 0, 0, 0)).toBe(0);
  });

  it("never returns a negative grant when usage already exceeds a lowered limit", () => {
    expect(grantedUnits(2, 5, 0, 8)).toBe(0);
  });
});

describe("provider error classification", () => {
  /**
   * An invalid key returns 401 on every attempt — waiting through the whole
   * backoff schedule only delays the error the user needs to see.
   */
  it("client-side statuses are not worth retrying", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isNonRetryableProviderStatus(status)).toBe(true);
    }
  });

  it("rate limits, server errors and network failures keep the retry path", () => {
    for (const status of [429, 500, 529, undefined]) {
      expect(isNonRetryableProviderStatus(status)).toBe(false);
    }
  });
});

describe("unit derivation", () => {
  it("produces a single odometer unit for fuel", () => {
    const units = buildAnalysisUnits("FUEL_ODOMETER", {
      odometerPhotoPath: "fuel/photo.webp",
      reportedMileage: 123456,
    });

    expect(units).toEqual([
      {
        unitKey: "odometer",
        photoPath: "fuel/photo.webp",
        reportedValue: 123456,
      },
    ]);
  });

  /**
   * current_mileage first: a partial quota grant spends its units on the
   * field with fraud potential before cosmetic ones.
   */
  it("puts the mileage field ahead of the rest and skips photoless fields", () => {
    const units = buildAnalysisUnits("CHECKLIST", {
      photosByField: {
        tires_condition: ["a.webp"],
        current_mileage: ["b.webp", "extra.webp"],
        horn_working: [],
      },
      checklistData: {
        tires_condition: "good",
        current_mileage: 88000,
        horn_working: true,
      },
    });

    expect(units.map((unit) => unit.unitKey)).toEqual([
      "current_mileage",
      "tires_condition",
    ]);

    // Only the primary photo of each field is billed and analyzed.
    expect(units[0].photoPath).toBe("b.webp");
    expect(units[0].reportedValue).toBe(88000);
  });
});

describe("idempotency key", () => {
  it("is stable under key ordering", () => {
    const inputA = { photosByField: { a: ["1"] }, checklistData: { x: 1, y: 2 } };
    const inputB = { checklistData: { y: 2, x: 1 }, photosByField: { a: ["1"] } };

    expect(computeIdempotencyKey("CHECKLIST", "rec-1", inputA)).toBe(
      computeIdempotencyKey("CHECKLIST", "rec-1", inputB),
    );
  });

  it("changes when the input changes", () => {
    const base = { odometerPhotoPath: "p.webp", reportedMileage: 100 };

    expect(computeIdempotencyKey("FUEL_ODOMETER", "rec-1", base)).not.toBe(
      computeIdempotencyKey("FUEL_ODOMETER", "rec-1", {
        ...base,
        reportedMileage: 101,
      }),
    );
  });

  it("stringifies nested structures deterministically", () => {
    expect(stableStringify({ b: [1, { d: 2, c: 3 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":3,"d":2}]}',
    );
  });
});

describe("odometer evaluation", () => {
  const readable = { confianca: 90, legivel: true, sinais_fraude: false };

  it("verifies a reading within both thresholds", () => {
    const result = evaluateOdometerReading(
      { ...readable, valor_lido: 100030 },
      100000,
    );

    expect(result.status).toBe("verified");
    expect(result.readMileage).toBe(100030);
  });

  /**
   * A mismatch needs to clear the absolute AND the relative threshold: 60 km
   * off at 100k km is within 5%, so it still verifies — same tolerance the
   * legacy service applied.
   */
  it("tolerates a divergence that only exceeds one threshold", () => {
    const result = evaluateOdometerReading(
      { ...readable, valor_lido: 100060 },
      100000,
    );

    expect(result.status).toBe("verified");
  });

  it("flags a mismatch beyond both thresholds", () => {
    const result = evaluateOdometerReading(
      { ...readable, valor_lido: 90000 },
      100000,
    );

    expect(result.status).toBe("mismatch");
  });

  it("fraud signals override the numeric comparison", () => {
    const result = evaluateOdometerReading(
      {
        ...readable,
        valor_lido: 100000,
        sinais_fraude: true,
        motivos_fraude: ["foto de tela"],
      },
      100000,
    );

    expect(result.status).toBe("fraud");
    expect(result.details).toContain("foto de tela");
  });

  it("treats an unreadable image as a result, not an error", () => {
    const result = evaluateOdometerReading(
      { legivel: false, valor_lido: null, confianca: 20 },
      100000,
    );

    expect(result.status).toBe("unreadable");
    expect(result.readMileage).toBeNull();
  });
});

describe("checklist field evaluation", () => {
  it("confirms when the model agrees, whichever response key it used", () => {
    expect(
      evaluateChecklistField({ corresponde_ao_informado: true, confianca: 80 })
        .status,
    ).toBe("confirmed");

    expect(
      evaluateChecklistField({ corresponde: true, confianca: 80 }).status,
    ).toBe("confirmed");
  });

  it("contradicts when the model disagrees", () => {
    const result = evaluateChecklistField({
      corresponde_ao_informado: false,
      confianca: 95,
      observacao: "pneu careca",
    });

    expect(result.status).toBe("contradicts");
    expect(result.observation).toBe("pneu careca");
  });
});

describe("checklist result merge", () => {
  const confirmed = { status: "confirmed", confidence: 90 };
  const contradicts = { status: "contradicts", confidence: 85 };

  it("new results override the same field, other fields survive", () => {
    const { merged } = mergeChecklistResults(
      { tires_condition: contradicts, horn_working: confirmed },
      { tires_condition: confirmed },
    );

    expect(merged.tires_condition.status).toBe("confirmed");
    expect(merged.horn_working).toEqual(confirmed);
  });

  /**
   * The overall verdict is recomputed across old + new fields: an update
   * that re-verifies one photo must not hide a contradiction that still
   * stands on another field.
   */
  it("a surviving contradiction keeps the record in issues_found", () => {
    const { overallStatus } = mergeChecklistResults(
      { tires_condition: contradicts },
      { horn_working: confirmed },
    );

    expect(overallStatus).toBe("issues_found");
  });

  it("all confirmed yields verified", () => {
    const { overallStatus } = mergeChecklistResults(
      {},
      { tires_condition: confirmed, horn_working: confirmed },
    );

    expect(overallStatus).toBe("verified");
  });

  it("nothing successfully analyzed yields error", () => {
    const { overallStatus } = mergeChecklistResults(
      {},
      { tires_condition: { status: "inconclusive", confidence: 0 } },
    );

    expect(overallStatus).toBe("error");
  });

  it("an inconclusive with confidence still counts as analyzed", () => {
    const { overallStatus } = mergeChecklistResults(
      {},
      { tires_condition: { status: "inconclusive", confidence: 40 } },
    );

    expect(overallStatus).toBe("verified");
  });
});
