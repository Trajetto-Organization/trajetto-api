import { describe, expect, it } from "vitest";

import { odometerFromLines, proofFromLines } from "../ocr-rules.mjs";

/** An OCR line with an axis-aligned box. */
const line = (text, x, y, w, h, score = 0.98) => ({
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
    expect(answer.nome_recebedor_lido).toBe("Carla M. Souza");
    expect(answer.tem_assinatura).toBe("nao_sei");
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
});
