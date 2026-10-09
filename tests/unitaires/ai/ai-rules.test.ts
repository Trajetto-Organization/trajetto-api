import { describe, expect, it } from "vitest";

import { parseModelAnswer } from "@/shared/ai/ai-answers";
import {
  aiRecordTypeOf,
  buildAnalysisUnits,
  computeIdempotencyKey,
  evaluateChecklistField,
  evaluateOdometerReading,
  grantedUnits,
  mergeChecklistResults,
  parseReceiptDate,
  projectChecklistInput,
  readProofExtraction,
  reassessChecklistField,
  restoreOdometerResult,
  stableStringify,
  unitConfidence,
} from "@/shared/ai/ai-rules";
import {
  PROOF_INPUT_VERSION,
  type DeliveryProofAnalysisInput,
} from "@/shared/ai/ai-types";

/** The model's answers go through the real schema, as in production. */
const odometer = (answer: Record<string, unknown>) =>
  parseModelAnswer(
    "odometer",
    JSON.stringify({
      sinais_fraude: false,
      motivos_fraude: [],
      observacao: "",
      ...answer,
    }),
  );

const proof = (answer: Record<string, unknown>) =>
  parseModelAnswer(
    "proof",
    JSON.stringify({
      e_canhoto: "sim",
      numero_documento_lido: "000045118",
      data_recebimento_lida: "27/09/2026",
      tem_assinatura: "sim",
      nome_recebedor_lido: "Maria Souza",
      legivel: "sim",
      qualidade_foto: 0.9,
      confianca: 0.9,
      observacao: "Canhoto legível.",
      ...answer,
    }),
  );

const PROOF_INPUT: DeliveryProofAnalysisInput = {
  photoPath: "deliveryProofs/p.jpg",
  signaturePath: null,
  expectedDocument: "45118",
  expectedRecipient: "Mercado Central",
  provenOn: "2026-09-27",
  inputVersion: PROOF_INPUT_VERSION,
};

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

  // Red on the old code: Object.entries(date) is empty, so every Date hashed
  // as `{}` and two different days were the same input (AI-2).
  it("tells two days apart", () => {
    expect(stableStringify({ at: new Date("2026-09-01T00:00:00Z") })).not.toBe(
      stableStringify({ at: new Date("2026-09-02T00:00:00Z") }),
    );
    expect(stableStringify(new Date("2026-09-01T00:00:00Z"))).toBe(
      '"2026-09-01T00:00:00.000Z"',
    );
  });
});

describe("the checklist input that is hashed (AI-2)", () => {
  const photos = {
    current_mileage: ["km.jpg"],
    tires_condition: ["pneu.jpg"],
  };

  /**
   * The creation sends the form's values; the manual button used to send the
   * whole row, verdict columns included. After an analysis finished, the row
   * changed — and the same photos became a new request that paid for every
   * one of them again.
   */
  it("is the same for the form payload and for the database row", () => {
    const fromForm = projectChecklistInput({
      photosByField: photos,
      checklistData: {
        current_mileage: 88000,
        tires_condition: "good",
        checklist_date: "2026-09-27",
        notes: "ok",
      },
    });

    const fromRow = projectChecklistInput({
      photosByField: photos,
      checklistData: {
        id: "chk-1",
        current_mileage: 88000,
        tires_condition: "good",
        checklist_date: new Date("2026-09-27T00:00:00Z"),
        ai_verification_status: "verified",
        ai_verification_details: { tires_condition: { status: "confirmed" } },
        updated_at: new Date(),
      },
    });

    expect(fromRow).toEqual(fromForm);
    expect(computeIdempotencyKey("CHECKLIST", "chk-1", fromRow)).toBe(
      computeIdempotencyKey("CHECKLIST", "chk-1", fromForm),
    );
  });

  it("keeps only photographed fields, and drops fields with no photo", () => {
    expect(
      projectChecklistInput({
        photosByField: { tires_condition: ["pneu.jpg"], horn_working: [] },
        checklistData: { tires_condition: "bad", horn_working: true },
      }),
    ).toEqual({
      photosByField: { tires_condition: ["pneu.jpg"] },
      checklistData: { tires_condition: "bad" },
    });
  });
});

describe("odometer evaluation (blind reading, compared in code)", () => {
  it("verifies a reading within both thresholds", () => {
    const result = evaluateOdometerReading(
      odometer({ valor_lido: 100020, confianca: 0.9, legivel: true }),
      100000,
    );

    expect(result.status).toBe("verified");
    expect(result.readMileage).toBe(100020);
    expect(result.reportedMileage).toBe(100000);
  });

  it("tolerates a divergence that only exceeds one threshold", () => {
    // 60 km over 100000 = 0.06% — above 50 km, below 5%.
    expect(
      evaluateOdometerReading(
        odometer({ valor_lido: 100060, confianca: 0.9, legivel: true }),
        100000,
      ).status,
    ).toBe("verified");
  });

  it("flags a mismatch beyond both thresholds", () => {
    const result = evaluateOdometerReading(
      odometer({ valor_lido: 154002, confianca: 0.9, legivel: true }),
      145002,
    );

    expect(result.status).toBe("mismatch");
    expect(result.details).toContain("154002");
  });

  it("fraud signals override the numeric comparison", () => {
    const result = evaluateOdometerReading(
      odometer({
        valor_lido: 100000,
        sinais_fraude: true,
        motivos_fraude: ["foto de tela"],
        confianca: 0.8,
        legivel: true,
      }),
      100000,
    );

    expect(result.status).toBe("fraud");
    expect(result.fraudReasons).toEqual(["foto de tela"]);
  });

  it("treats an unreadable image as a result, not an error", () => {
    const result = evaluateOdometerReading(
      odometer({ legivel: false, valor_lido: null, confianca: 0.1 }),
      100000,
    );

    expect(result.status).toBe("unreadable");
    expect(result.readMileage).toBeNull();
  });

  // Red on the old code: the prompt asked 0–100, the pipeline passed it on
  // and the web multiplied by 100 — "8500%" (AI-3).
  it("keeps the confidence on the 0–1 scale, whatever scale the model used", () => {
    expect(
      evaluateOdometerReading(
        odometer({ valor_lido: 100000, confianca: 85, legivel: true }),
        100000,
      ).confidence,
    ).toBe(0.85);
  });
});

describe("checklist field evaluation", () => {
  const condition = (condicao_observada: string) => ({
    kind: "condition" as const,
    answer: parseModelAnswer(
      "condition",
      JSON.stringify({ condicao_observada, confianca: 0.9, observacao: "" }),
    ),
  });

  it("confirms a grade on the same side as the informed one", () => {
    expect(evaluateChecklistField(condition("good"), "good").status).toBe(
      "confirmed",
    );
    // A matter of degree: both say the item is not good.
    expect(
      evaluateChecklistField(condition("needs_attention"), "bad").status,
    ).toBe("confirmed");
  });

  it("contradicts a 'good' the photo does not show", () => {
    const result = evaluateChecklistField(condition("bad"), "good");

    expect(result).toMatchObject({
      status: "contradicts",
      observed: "bad",
      informed: "good",
      confidence: 0.9,
    });
  });

  // Red on the old code: `corresponde_ao_informado ?? corresponde ?? true`
  // made "the model did not say" read as "confirmed" (AI-14).
  it("never confirms what the photo could not settle", () => {
    expect(evaluateChecklistField(condition("nao_sei"), "good").status).toBe(
      "inconclusive",
    );
  });

  it("reads the fuel level and decides 'adequate' in code", () => {
    const level = (nivel_estimado: string) => ({
      kind: "fuel_level" as const,
      answer: parseModelAnswer(
        "fuel_level",
        JSON.stringify({ nivel_estimado, confianca: 0.8, observacao: "" }),
      ),
    });

    expect(evaluateChecklistField(level("reserva"), true).status).toBe(
      "contradicts",
    );
    expect(evaluateChecklistField(level("um_quarto"), true).status).toBe(
      "confirmed",
    );
    expect(evaluateChecklistField(level("ilegivel"), true).status).toBe(
      "inconclusive",
    );
  });

  it("compares a working item with the informed yes/no", () => {
    const working = (item_ok: string) => ({
      kind: "working" as const,
      answer: parseModelAnswer(
        "working",
        JSON.stringify({ item_ok, confianca: 0.7, observacao: "" }),
      ),
    });

    expect(evaluateChecklistField(working("nao"), false).status).toBe(
      "confirmed",
    );
    expect(evaluateChecklistField(working("sim"), false).status).toBe(
      "contradicts",
    );
  });

  it("compares the mileage read with the informed one", () => {
    const reading = {
      kind: "odometer" as const,
      answer: odometer({ valor_lido: 150233, confianca: 0.9, legivel: true }),
    };

    // The anchoring case the benchmark measured: the model read 150233 and
    // said it "matched" 105233. Here the code compares.
    expect(evaluateChecklistField(reading, 105233).status).toBe("contradicts");
    expect(evaluateChecklistField(reading, 150233).status).toBe("confirmed");
  });
});

describe("a paid checklist reading compared again (AI-2, blind reading)", () => {
  const bumpers = { condicao_observada: "bad", confianca: 0.9, observacao: "amassado" };

  it("follows the value the checklist holds now", () => {
    expect(reassessChecklistField("bumpers_condition", bumpers, "good")).toMatchObject({
      status: "contradicts",
      observed: "bad",
      informed: "good",
    });
    expect(reassessChecklistField("bumpers_condition", bumpers, "bad")).toMatchObject({
      status: "confirmed",
      informed: "bad",
    });
  });

  it("keeps a fraud sign whatever the mileage informed", () => {
    const tampered = {
      valor_lido: 1000,
      confianca: 0.9,
      legivel: true,
      sinais_fraude: true,
      motivos_fraude: ["tela sobreposta"],
      observacao: "",
    };

    expect(reassessChecklistField("current_mileage", tampered, 1000)?.status).toBe(
      "contradicts",
    );
  });

  it("leaves alone an answer stored in a shape it does not read", () => {
    expect(
      reassessChecklistField("bumpers_condition", { corresponde: true }, "bad"),
    ).toBeNull();
  });
});

describe("the receipt, compared in code (decision 6.9)", () => {
  it("confirms the number read against the invoice, leading zeros aside", () => {
    const reading = readProofExtraction(proof({}), PROOF_INPUT);

    expect(reading).toMatchObject({
      isReceipt: "yes",
      documentMatches: "yes",
      dateVisible: "yes",
      hasSignature: "yes",
    });
    expect(reading.extracted).toMatchObject({
      documentNumber: "45118",
      receiptDate: "2026-09-27",
      recipientName: "Maria Souza",
    });
    expect(reading.expected).toMatchObject({
      documentNumber: "45118",
      provenOn: "2026-09-27",
    });
  });

  it("says 'no' to another delivery's receipt", () => {
    expect(
      readProofExtraction(proof({ numero_documento_lido: "112907" }), PROOF_INPUT)
        .documentMatches,
    ).toBe("no");
  });

  it("has nothing to compare when the delivery has no invoice", () => {
    expect(
      readProofExtraction(proof({}), { ...PROOF_INPUT, expectedDocument: null })
        .documentMatches,
    ).toBe("not_applicable");
  });

  // Queued before decision 6.9, the expected document fell back to the
  // delivery's code: comparing with it called a good receipt "wrong NF-e".
  it("does not compare the number of an input queued before 6.9", () => {
    const { inputVersion: _version, ...legacy } = PROOF_INPUT;

    const reading = readProofExtraction(proof({}), {
      ...legacy,
      expectedDocument: "ENT-000123",
    });

    expect(reading.documentMatches).toBe("not_applicable");
    expect(reading.expected?.documentNumber).toBeNull();

    // Even when the code's digits happen to match the delivery's NF-e.
    expect(
      readProofExtraction(
        proof({ numero_documento_lido: "123" }),
        { ...legacy, expectedDocument: "ENT-000123" },
        "999",
      ).documentMatches,
    ).toBe("not_applicable");
  });

  // Red before: every input queued before 6.9 dropped its number, and the
  // reviewer read "Sem número para conferir" on a delivery that has an NF-e.
  it("compares an input queued before 6.9 whose expected number is the delivery's NF-e", () => {
    const { inputVersion: _version, ...legacy } = PROOF_INPUT;

    const same = readProofExtraction(proof({}), legacy, "000045118");

    expect(same.documentMatches).toBe("yes");
    expect(same.expected?.documentNumber).toBe("45118");

    expect(
      readProofExtraction(proof({ numero_documento_lido: "112907" }), legacy, "45118")
        .documentMatches,
    ).toBe("no");

    // The delivery's NF-e is not known (or was corrected since): not trusted.
    expect(readProofExtraction(proof({}), legacy, null).documentMatches).toBe(
      "not_applicable",
    );
  });

  // Red before: the strict `=== 2` stopped comparing on any later version.
  it("keeps comparing on a later input version", () => {
    expect(
      readProofExtraction(proof({ numero_documento_lido: "112907" }), {
        ...PROOF_INPUT,
        inputVersion: PROOF_INPUT_VERSION + 1,
      }).documentMatches,
    ).toBe("no");
  });

  // The benchmark's P08/P09/P12: the model read the printed EMISSÃO date as
  // readily as the handwritten receiving date. "Any date" is not enough.
  it("refuses a date that is not the day of the delivery", () => {
    expect(
      readProofExtraction(proof({ data_recebimento_lida: "25/09/2026" }), PROOF_INPUT)
        .dateVisible,
    ).toBe("no");
  });

  it("accepts the day before (signed before midnight, registered after)", () => {
    expect(
      readProofExtraction(proof({ data_recebimento_lida: "26/09/26" }), PROOF_INPUT)
        .dateVisible,
    ).toBe("yes");
  });

  it("takes the on-screen signature the driver collected as the signature", () => {
    const reading = readProofExtraction(proof({ tem_assinatura: "nao" }), {
      ...PROOF_INPUT,
      signaturePath: "deliverySignatures/s.png",
    });

    expect(reading.hasSignature).toBe("yes");
    expect(reading.extracted).toMatchObject({
      signatureOnPaper: "no",
      digitalSignature: true,
    });
  });

  it("reads handwritten dates, and refuses what is not a day", () => {
    expect(parseReceiptDate("27/09/2026", "2026-09-27")).toBe("2026-09-27");
    expect(parseReceiptDate("27.9", "2026-09-27")).toBe("2026-09-27");
    expect(parseReceiptDate("31/02/2026", "2026-09-27")).toBeNull();
    expect(parseReceiptDate(null, "2026-09-27")).toBeNull();
  });
});

describe("results paid before the 0–1 scale", () => {
  it("are read back on the one scale", () => {
    expect(unitConfidence(85)).toBe(0.85);
    expect(unitConfidence(0.4)).toBe(0.4);
    expect(unitConfidence(undefined)).toBe(0);
  });

  it("restore an odometer unit saved in the old shape", () => {
    const restored = restoreOdometerResult(
      {
        status: "verified",
        readMileage: 1000,
        confidence: 95,
        details: "Verificado",
        rawResponse: { observacao: "nítido" },
      },
      1000,
    );

    expect(restored).toMatchObject({
      confidence: 0.95,
      reportedMileage: 1000,
      observation: "nítido",
      fraudReasons: [],
    });
  });
});

describe("the record type an event carries (AI-7)", () => {
  // Red on the old code: the proof went out as "checklist".
  it("names the proof as a proof", () => {
    expect(aiRecordTypeOf("DELIVERY_PROOF")).toBe("proof");
    expect(aiRecordTypeOf("FUEL_ODOMETER")).toBe("fuel");
    expect(aiRecordTypeOf("CHECKLIST")).toBe("checklist");
  });
});

describe("checklist result merge", () => {
  const confirmed = { status: "confirmed", confidence: 0.9 };
  const contradicts = { status: "contradicts", confidence: 0.85 };

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
      { tires_condition: { status: "inconclusive", confidence: 0.4 } },
    );

    expect(overallStatus).toBe("verified");
  });
});

describe("units for a reader that covers only some kinds (ADR 0010 §5)", () => {
  const ocr = (kind: string) => kind === "proof" || kind === "odometer";

  it("a checklist of eight photos with one odometer spends one unit", () => {
    const units = buildAnalysisUnits(
      "CHECKLIST",
      {
        photosByField: {
          tires_condition: ["t.jpg"],
          fuel_level_adequate: ["f.jpg"],
          current_mileage: ["km.jpg"],
          headlights_working: ["h.jpg"],
          windshield_condition: ["w.jpg"],
          spare_tire_condition: ["s.jpg"],
          brakes_working: ["b.jpg"],
          fire_extinguisher_valid: ["e.jpg"],
        },
        checklistData: { current_mileage: 1000, fuel_level_adequate: true },
      },
      ocr,
    );

    expect(units.map((unit) => unit.unitKey)).toEqual(["current_mileage"]);
  });

  it("an unknown field is judged by the value it holds: a number is an odometer", () => {
    const units = buildAnalysisUnits(
      "CHECKLIST",
      {
        photosByField: { custom_km: ["a.jpg"], custom_flag: ["b.jpg"] },
        checklistData: { custom_km: 5, custom_flag: true },
      },
      ocr,
    );

    expect(units.map((unit) => unit.unitKey)).toEqual(["custom_km"]);
  });

  it("fuel and proof keep their one unit; a reader that covers nothing creates none", () => {
    const fuel = { odometerPhotoPath: "o.jpg", reportedMileage: 10 };

    expect(buildAnalysisUnits("FUEL_ODOMETER", fuel, ocr)).toHaveLength(1);
    expect(buildAnalysisUnits("FUEL_ODOMETER", fuel, () => false)).toHaveLength(0);

    const proof: DeliveryProofAnalysisInput = {
      photoPath: "p.jpg",
      signaturePath: null,
      expectedDocument: "1",
      expectedRecipient: "x",
      provenOn: "2026-10-05",
      inputVersion: PROOF_INPUT_VERSION,
    };

    expect(buildAnalysisUnits("DELIVERY_PROOF", proof, ocr)).toHaveLength(1);
    expect(buildAnalysisUnits("DELIVERY_PROOF", proof, () => false)).toHaveLength(0);
  });

  it("without a coverage every photo is a unit, as the pipeline rebuilds them", () => {
    const units = buildAnalysisUnits("CHECKLIST", {
      photosByField: { tires_condition: ["t.jpg"], current_mileage: ["km.jpg"] },
      checklistData: {},
    });

    expect(units).toHaveLength(2);
  });
});

describe("a reader that does not judge the signature or the fraud (ADR 0010 §3)", () => {
  const input: DeliveryProofAnalysisInput = {
    photoPath: "p.jpg",
    signaturePath: "signatures/s.png",
    expectedDocument: "45181",
    expectedRecipient: "Mercado",
    provenOn: "2026-09-27",
    inputVersion: PROOF_INPUT_VERSION,
  };

  const clean = {
    e_canhoto: "sim",
    numero_documento_lido: "000045181",
    data_recebimento_lida: "27/09/2026",
    tem_assinatura: "nao_sei",
    legivel: "sim",
    qualidade_foto: 0.98,
    confianca: 0.98,
    observacao: "",
  };

  it("leaves the signature for a person even with the on-screen one", () => {
    const reading = readProofExtraction(
      parseModelAnswer("proof", JSON.stringify({ ...clean, assinatura_avaliada: false })),
      input,
    );

    expect(reading.hasSignature).toBe("unknown");
    expect(reading.extracted).toMatchObject({ digitalSignature: true, signatureAssessed: false });
  });

  it("keeps the on-screen signature deciding for a reader that did look (a model)", () => {
    const reading = readProofExtraction(
      parseModelAnswer("proof", JSON.stringify(clean)),
      input,
    );

    expect(reading.hasSignature).toBe("yes");
    expect(reading.extracted).not.toHaveProperty("signatureAssessed");
  });

  it("says 'km confere', not 'Verificado', when fraud was not judged", () => {
    const result = evaluateOdometerReading(
      odometer({ valor_lido: 84312, confianca: 1, legivel: true, observacao: "", fraude_avaliada: false }),
      84312,
    );

    expect(result).toMatchObject({ status: "verified", fraudAssessed: false });
    expect(result.details).toBe(
      "Km lida confere com a informada (84312 km; informado: 84312 km). A leitura automática não identifica foto de tela ou montagem.",
    );
  });

  it("keeps a restored result's 'fraud not judged' on a retry that reuses it", () => {
    const restored = restoreOdometerResult(
      { status: "verified", readMileage: 10, reportedMileage: 10, confidence: 1, details: "x", fraudAssessed: false },
      10,
    );

    expect(restored.fraudAssessed).toBe(false);
  });

  it("results stored before 05/10/2026 count as judged", () => {
    expect(
      parseModelAnswer("odometer", JSON.stringify({ valor_lido: 1, confianca: 1, legivel: true, sinais_fraude: false, observacao: "" })).fraude_avaliada,
    ).toBe(true);
  });
});
