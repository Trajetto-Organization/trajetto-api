import { describe, expect, it } from "vitest";

import QRCode from "qrcode";

import {
  buildProofDocumentModel,
  type ProofDocumentSource,
  type ProofSigningIntent,
} from "@/shared/delivery/proof-document";

import { renderProofPdf } from "@/shared/services/proof-pdf-service";

/**
 * The links of the authentication block (DLVB-09, decision 5.11, design
 * §6.6), asserted on the rendered bytes — a link annotation is exactly the
 * part the model cannot express.
 *
 * - The /verificar URL wraps; a plain-text URL made viewers link only its
 *   first line, opening /verificar/ without the token. Every annotation must
 *   carry the WHOLE address.
 * - Signed: the main QR is the ITI validator (as in the model) and a second,
 *   smaller QR plus the printed line lead to /verificar.
 * - Unsigned: one QR, to /verificar; nothing points at the ITI.
 */
const BASE = "https://app.trajetto.com.br";
const TOKEN = "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e";
const VERIFY_URL = `${BASE}/verificar/${TOKEN}`;
const ITI = "https://validar.iti.gov.br";

function source(): ProofDocumentSource {
  return {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: null,
      invoice_number: "12345",
      recipient_name: "Padaria Central Ltda",
      recipient_document: "11222333000181",
      street: "Praça da Sé",
      address_number: "100",
      complement: null,
      neighborhood: "Sé",
      city: "São Paulo",
      uf: "SP",
      cep: "01001000",
      delivered_at: new Date("2026-09-16T13:30:00.000Z"),
      received_by: "Maria Souza",
      shipper: { name: "Distribuidora Norte", cnpj: "11222333000199" },
    },
    business: { corporate_reason: "Transportes Silva Ltda", cnpj: "11222333000166" },
    driver: { name: "João Motorista", cpf: "12345678900" },
    route: { code: 42, name: null },
    proof: {
      created_at: new Date("2026-09-16T13:30:00.000Z"),
      latitude: -23.550519,
      longitude: -46.633308,
      photoKey: "delivery/photo.png",
      signatureKey: null,
    },
    occurrences: [],
  };
}

const model = (signing: ProofSigningIntent) =>
  buildProofDocumentModel(source(), {
    verificationBaseUrl: BASE,
    verificationToken: TOKEN,
    signing,
  });

/** Every URI a link annotation in the file points at. */
function linkTargets(bytes: Buffer): string[] {
  return [...bytes.toString("latin1").matchAll(/\/URI \(([^)]*)\)/g)].map((match) => match[1]);
}

const pageCount = (bytes: Buffer): number =>
  (bytes.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe("the links of an UNSIGNED receipt", () => {
  it("all open /verificar for this token, on every wrapped line and on the QR", async () => {
    const rendered = await renderProofPdf(model({ status: "UNSIGNED" }), {
      photo: null,
      signature: null,
    });

    const targets = linkTargets(rendered.bytes);

    expect(
      (rendered.bytes.toString("latin1").match(/\/Subtype \/Link/g) ?? []).length,
    ).toBe(targets.length);

    // The printed URL (one annotation per line) plus the QR.
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const target of targets) expect(target).toBe(VERIFY_URL);
  }, 30_000);
});

describe("the links of a SIGNED receipt", () => {
  const signing: ProofSigningIntent = {
    status: "SIGNED",
    signer: { name: "TRAJETTO SISTEMAS LTDA", cnpj: "11222333000181" },
  };

  it("point the main QR at the ITI validator, and the rest at /verificar, whole", async () => {
    const rendered = await renderProofPdf(model(signing), { photo: null, signature: null });

    const targets = linkTargets(rendered.bytes);

    expect(targets.filter((target) => target === ITI)).toHaveLength(1);

    const others = targets.filter((target) => target !== ITI);

    // The secondary QR plus the printed URL's lines (it wraps in the column).
    expect(others.length).toBeGreaterThanOrEqual(3);
    for (const target of others) expect(target).toBe(VERIFY_URL);
  }, 30_000);

  it("keeps the authentication block on the first page when the photo leaves room", async () => {
    const photo = await QRCode.toBuffer("foto do canhoto", { type: "png", width: 600, margin: 1 });

    const rendered = await renderProofPdf(model(signing), { photo, signature: null });

    expect(pageCount(rendered.bytes)).toBe(1);
  }, 30_000);
});
