import { describe, expect, it } from "vitest";

import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";

/**
 * The day the model is told a receipt was signed on (DLVP-PROOF-4).
 *
 * It was the UTC day: a receipt signed at 22:00 in São Paulo was sent to the
 * model as the next day, and a slip dated correctly by the recipient read as
 * "the date does not match". The day is the company's business day
 * (decision 1.1), never the server's.
 */
const source = (provenAt: Date, timeZone?: string | null) => ({
  photoPath: "deliveryPhotos/b/photo.jpg",
  signaturePath: null,
  delivery: { invoice_number: "12345", code: null, recipient_name: "Padaria" },
  provenAt,
  timeZone,
});

describe("the day a receipt was signed on", () => {
  it("is the São Paulo day for a proof at 22:00 there, not the UTC one", () => {
    // 2026-09-17T01:00Z is 22:00 of the 16th in America/Sao_Paulo.
    const input = buildProofAnalysisInput(
      source(new Date("2026-09-17T01:00:00.000Z")),
    );

    expect(input.provenOn).toBe("2026-09-16");
  });

  it("follows the company's own zone", () => {
    // 03:30Z is 23:30 of the 16th in Manaus (UTC-4) and 00:30 of the 17th in
    // Noronha (UTC-2): the same instant, two different days.
    const instant = new Date("2026-09-17T03:30:00.000Z");

    expect(
      buildProofAnalysisInput(source(instant, "America/Manaus")).provenOn,
    ).toBe("2026-09-16");
    expect(
      buildProofAnalysisInput(source(instant, "America/Noronha")).provenOn,
    ).toBe("2026-09-17");
  });

  it("falls back to the default zone for an empty or unknown one", () => {
    const instant = new Date("2026-09-17T01:00:00.000Z");

    expect(buildProofAnalysisInput(source(instant, null)).provenOn).toBe(
      "2026-09-16",
    );
    expect(
      buildProofAnalysisInput(source(instant, "Mars/Olympus")).provenOn,
    ).toBe("2026-09-16");
  });

  it("builds the same input for the same proof, so the request key is stable", () => {
    const instant = new Date("2026-09-17T01:00:00.000Z");

    expect(buildProofAnalysisInput(source(instant))).toEqual(
      buildProofAnalysisInput(source(instant, "America/Sao_Paulo")),
    );
  });
});
