import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseModelAnswer } from "@/shared/ai/ai-answers";
import {
  evaluateChecklistField,
  evaluateOdometerReading,
  parseReceiptDate,
  readProofExtraction,
} from "@/shared/ai/ai-rules";
import { PROOF_INPUT_VERSION } from "@/shared/ai/ai-types";
import {
  OCR_RULES_VERSION,
  odometerFromLines,
  proofFromLines,
  type OcrLine,
} from "@/shared/ai/local/ocr-readings";
import { assessProof } from "@/shared/ai/proof-criteria";

/**
 * OCR lines -> the product's answer (ADR 0010 §3, item 2), ported from the
 * benchmark's scripts/ai-benchmark/ocr-rules.mjs.
 *
 * The fixture holds the REAL lines RapidOCR returned for the 36 synthetic
 * photos the benchmark read on 05/10/2026 (receipt profile for receipts,
 * digits profile for odometers), and what ocr-rules.mjs answered. The port
 * must answer the same, except where the product decided otherwise: the
 * recipient's name is never "read", and signature and fraud are declared
 * not assessed.
 */

interface FixtureItem {
  id: string;
  kind: "proof" | "odometer";
  description: string;
  lines: OcrLine[];
  benchmarkAnswer: Record<string, unknown>;
  input: Record<string, unknown>;
  truth: Record<string, unknown>;
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/ocr-combo-2026-10.json"),
    "utf8",
  ),
) as { items: FixtureItem[] };

const proofs = fixture.items.filter((item) => item.kind === "proof");
const odometers = fixture.items.filter((item) => item.kind === "odometer");

/** An OCR line with an axis-aligned box. */
const line = (
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  score = 0.98,
): OcrLine => ({
  text,
  score,
  box: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ],
});

const STUB = [
  line(
    "RECEBEMOS DE DISTRIBUIDORA LTDA ... EMISSÃO: 25/09/2026 VALOR TOTAL: R$ 3.482,90",
    100,
    100,
    900,
    20,
  ),
  line("NF-e", 1100, 110, 60, 30),
  line("N° 000.045.181", 1060, 150, 160, 24),
  line("DATA DE RECEBIMENTO", 100, 160, 150, 14),
  line("IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR", 400, 160, 300, 14),
];

const PROOF_INPUT = {
  photoPath: "proofs/x.jpg",
  signaturePath: null,
  expectedDocument: "45181",
  expectedRecipient: "Mercado Boa Vista Ltda",
  provenOn: "2026-09-27",
  inputVersion: PROOF_INPUT_VERSION,
};

describe("the ported rules agree with the benchmark that measured them", () => {
  it.each(proofs.map((item) => [item.id, item] as const))(
    "receipt %s",
    (_id, item) => {
      const answer = proofFromLines(item.lines);
      const {
        nome_recebedor_lido: _name,
        observacao: _obs,
        qualidade_foto: quality,
        confianca: confidence,
        ...measured
      } = item.benchmarkAnswer;

      expect(answer).toMatchObject(measured);
      // The fixture keeps each line's score to 3 decimals; the run averaged
      // the full scores, so the mean may differ in the last digit.
      expect(answer.qualidade_foto).toBeCloseTo(quality as number, 2);
      expect(answer.confianca).toBeCloseTo(confidence as number, 2);
      expect(answer.nome_recebedor_lido).toBeNull();
      expect(answer.assinatura_avaliada).toBe(false);
    },
  );

  it.each(odometers.map((item) => [item.id, item] as const))(
    "odometer %s",
    (_id, item) => {
      const answer = odometerFromLines(item.lines);
      const {
        observacao: _obs,
        confianca: confidence,
        ...measured
      } = item.benchmarkAnswer;

      expect(answer).toMatchObject(measured);
      expect(answer.confianca).toBeCloseTo(confidence as number, 2);
      expect(answer.fraude_avaliada).toBe(false);
    },
  );

  it("covers every synthetic receipt and odometer of the run", () => {
    expect(proofs).toHaveLength(20);
    expect(odometers).toHaveLength(16);
  });
});

describe("the answers pass the product's schema (a porting bug is an invalid answer, never a verdict)", () => {
  it.each(fixture.items.map((item) => [item.id, item] as const))(
    "%s",
    (_id, item) => {
      const answer =
        item.kind === "proof"
          ? proofFromLines(item.lines)
          : odometerFromLines(item.lines);

      expect(() =>
        parseModelAnswer(item.kind, JSON.stringify(answer)),
      ).not.toThrow();
    },
  );
});

describe("what the product makes of them", () => {
  it("never suggests 'looks_good' for any receipt: the signature is not read", () => {
    for (const item of proofs) {
      const answer = parseModelAnswer(
        "proof",
        JSON.stringify(proofFromLines(item.lines)),
      );
      const reading = readProofExtraction(answer, {
        ...PROOF_INPUT,
        // Even with the on-screen signature the driver collected.
        signaturePath: "signatures/x.png",
      });

      expect(assessProof(reading).suggestion, item.id).not.toBe("looks_good");
      expect(reading.hasSignature, item.id).toBe("unknown");
    }
  });

  it("flags the receipts with another invoice number or another day", () => {
    const suggestion = (id: string) => {
      const item = proofs.find((candidate) => candidate.id === id)!;
      const answer = parseModelAnswer(
        "proof",
        JSON.stringify(proofFromLines(item.lines)),
      );

      return assessProof(readProofExtraction(answer, PROOF_INPUT));
    };

    expect(suggestion("P06")).toMatchObject({
      suggestion: "looks_wrong",
      failed: ["documentMatches"],
    });
    expect(suggestion("P07")).toMatchObject({ suggestion: "looks_wrong" });
    expect(suggestion("P07").failed).toContain("documentMatches");
    expect(suggestion("P18").failed).toContain("dateVisible");

    // A correct receipt goes to a person, never back to the driver.
    expect(suggestion("P01")).toMatchObject({
      suggestion: "needs_review",
      failed: [],
    });
  });

  it("never gives the 'verified' seal to an odometer: fraud is not assessed", () => {
    for (const item of odometers.filter(
      (candidate) => candidate.input.reportedMileage,
    )) {
      const answer = parseModelAnswer(
        "odometer",
        JSON.stringify(odometerFromLines(item.lines)),
      );
      const result = evaluateOdometerReading(
        answer,
        item.input.reportedMileage as number,
      );

      expect(result.fraudAssessed, item.id).toBe(false);

      if (result.status === "verified") {
        expect(result.details, item.id).toMatch(
          /^Km lida confere com a informada/,
        );
        expect(result.details, item.id).toMatch(/não identifica foto de tela/);
      }
    }
  });

  it("O09, a photo of a screen, is at most 'km confere' — never 'Verificado'", () => {
    const item = odometers.find((candidate) => candidate.id === "O09")!;
    const answer = parseModelAnswer(
      "odometer",
      JSON.stringify(odometerFromLines(item.lines)),
    );
    const result = evaluateOdometerReading(answer, 76540);

    expect(result.status).toBe("verified");
    expect(result.fraudAssessed).toBe(false);
    expect(result.details).not.toMatch(/^Verificado/);
  });

  it("O03, the drum read as 5671 instead of 56719, is a mismatch for a person, not a pass", () => {
    const item = odometers.find((candidate) => candidate.id === "O03")!;
    const answer = parseModelAnswer(
      "odometer",
      JSON.stringify(odometerFromLines(item.lines)),
    );

    expect(answer.valor_lido).toBe(5671);
    expect(evaluateOdometerReading(answer, 56719).status).toBe("mismatch");
  });

  it("the checklist's km field says what was not checked when it agrees", () => {
    const item = odometers.find((candidate) => candidate.id === "K01")!;
    const answer = parseModelAnswer(
      "odometer",
      JSON.stringify(odometerFromLines(item.lines)),
    );
    const result = evaluateChecklistField({ kind: "odometer", answer }, 150233);

    expect(result.status).toBe("confirmed");
    expect(result.fraudAssessed).toBe(false);
    expect(result.observation).toMatch(/não identifica foto de tela/);
  });
});

describe("proofFromLines", () => {
  it("reads the number and the handwritten date under its label, never the EMISSÃO date", () => {
    const answer = proofFromLines([
      ...STUB,
      line("27/09/2026", 110, 200, 160, 40),
      line("Carla M. Souza", 560, 215, 150, 22),
    ]);

    expect(answer.e_canhoto).toBe("sim");
    expect(answer.numero_documento_lido).toBe("000045181");
    expect(answer.data_recebimento_lida).toBe("27/09/2026");
    expect(answer.tem_assinatura).toBe("nao_sei");
    // Read by the benchmark, never shown as read by the product.
    expect(answer.nome_recebedor_lido).toBeNull();
  });

  it("P11: a '/' read as '1' ('27109/2026') never becomes a valid date", () => {
    const answer = proofFromLines([
      ...STUB,
      line("27109/2026", 110, 200, 160, 40),
    ]);

    expect(answer.data_recebimento_lida).toBeNull();
    expect(parseReceiptDate("27109/2026", "2026-09-27")).toBeNull();
  });

  it("leaves the date null when the field is blank", () => {
    expect(proofFromLines(STUB).data_recebimento_lida).toBeNull();
  });

  it("does not call a box label a receipt", () => {
    const answer = proofFromLines([
      line("REMETENTE", 0, 0, 100, 20),
      line("NF 45181", 0, 40, 100, 20),
      line("FRÁGIL", 0, 80, 100, 20),
    ]);
    expect(answer.e_canhoto).toBe("nao");
  });

  it("answers an empty photo as unknown and illegible", () => {
    expect(proofFromLines([])).toMatchObject({
      e_canhoto: "nao_sei",
      numero_documento_lido: null,
      legivel: "nao",
      confianca: 0,
    });
  });
});

describe("odometerFromLines", () => {
  it("takes the reading next to ODO, not the trip nor dial labels", () => {
    const answer = odometerFromLines([
      line("100 120", 300, 50, 120, 30),
      line("TRIP A", 600, 300, 80, 20),
      line("3456", 700, 300, 90, 40),
      line("ODO", 600, 420, 50, 20),
      line("O84312", 680, 410, 160, 45),
    ]);
    expect(answer.valor_lido).toBe(84312);
    expect(answer.legivel).toBe(true);
  });

  it("merges a drum odometer read one digit per box", () => {
    const digits = "056719"
      .split("")
      .map((digit, index) => line(digit, 500 + index * 42, 600, 36, 50));
    expect(
      odometerFromLines([line("km/h", 400, 300, 60, 20), ...digits]).valor_lido,
    ).toBe(56719);
  });

  it("is unreadable when no digit run looks like an odometer", () => {
    const answer = odometerFromLines([line("bom dia", 0, 0, 100, 30)]);
    expect(answer.valor_lido).toBeNull();
    expect(answer.legivel).toBe(false);
  });

  it("never claims fraud signs: it cannot see them", () => {
    const answer = odometerFromLines([line("84312", 0, 0, 100, 30)]);
    expect(answer).toMatchObject({
      sinais_fraude: false,
      fraude_avaliada: false,
    });
  });
});

describe("OCR_RULES_VERSION", () => {
  it("is a positive integer, recorded with every reading", () => {
    expect(Number.isInteger(OCR_RULES_VERSION) && OCR_RULES_VERSION >= 1).toBe(
      true,
    );
  });
});
