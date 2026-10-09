import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  MISSING,
  buildProofDocumentModel,
  maskCpf,
  type ProofDocumentSource,
} from "@/shared/delivery/proof-document";

import { VerifyProofDocumentUseCase } from "@/modules/delivery/usecases/verify-proof-document/verify-proof-document-usecase";

import type { IProofDocumentRepository } from "@/modules/delivery/repositories/IProof-document-repository";
import type { UploadService } from "@/shared/services/upload-service";

/**
 * The public receipt (GAP1-8).
 *
 * Its verification link is printed as a QR on the document itself, needs no
 * login, and travels with every photo of the paper. Whoever holds one can open
 * the PDF. The recipient's document and the captured coordinates ARE the
 * evidence and stay; the driver's full CPF proves nothing about the delivery,
 * so the receipt carries only its middle digits. And the link does not work
 * forever: past the retention period it answers exactly like a link that
 * never existed.
 */
function source(cpf: string | null): ProofDocumentSource {
  return {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: "3".repeat(44),
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
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11222333000166",
    },
    driver: { name: "João Motorista", cpf },
    route: { code: 42, name: "Zona Sul — manhã" },
    proof: {
      created_at: new Date("2026-09-16T13:30:00.000Z"),
      latitude: -23.550519,
      longitude: -46.633308,
      device: "Moto G84 (Android 14)",
      photoKey: "delivery/photo.jpg",
      signatureKey: null,
    },
    occurrences: [],
  };
}

function driverDocument(cpf: string | null): string | undefined {
  const model = buildProofDocumentModel(source(cpf), {
    verificationBaseUrl: "https://app.trajetto.com.br",
    verificationToken: "token",
  });

  return model.sections.protocol.blocks
    .find((block) => block.heading === "Entregador")
    ?.lines.flat()
    .find((field) => field.label === "Doc. de identificação")?.value;
}

function everything(cpf: string): string {
  const model = buildProofDocumentModel(source(cpf), {
    verificationBaseUrl: "https://app.trajetto.com.br",
    verificationToken: "token",
  });

  return JSON.stringify(model);
}

describe("the driver's CPF on the receipt", () => {
  it("shows only the middle digits", () => {
    expect(driverDocument("12345678900")).toBe("***.456.789-**");
    expect(driverDocument("123.456.789-00")).toBe("***.456.789-**");
  });

  it("is never printed in full, anywhere on the document", () => {
    const printed = everything("12345678900");

    expect(printed).not.toContain("12345678900");
    expect(printed).not.toContain("123.456.789-00");
  });

  it("says it is missing rather than printing something that is not a CPF", () => {
    expect(driverDocument(null)).toBe(MISSING);
    expect(driverDocument("abc")).toBe(MISSING);
    expect(maskCpf("1234")).toBe(MISSING);
  });

  it("still carries the recipient's document and the coordinates: they are the evidence", () => {
    const printed = everything("12345678900");

    expect(printed).toContain("11222333000181");
    expect(printed).toContain("-23.5505190");
    expect(printed).toContain("-46.6333080");
  });
});

describe("the public verification link", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const bytes = Buffer.from("%PDF-1.7 comprovante");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  function useCase(generatedAt: Date) {
    const documents = {
      findByVerificationToken: async () => ({
        id: "doc-1",
        deliveryId: "018f0000-0000-7000-8000-0000000000e1",
        storage_key: "proof-documents/doc-1.pdf",
        sha256,
        version: 1,
        verification_token: "token",
        generated_at: generatedAt,
        delivery: {
          recipient_name: "Padaria Central Ltda",
          city: "São Paulo",
          uf: "SP",
          invoice_number: "12345",
          delivered_at: generatedAt,
          received_by: "Maria Souza",
          business: { corporate_reason: "Transportes Silva Ltda", fantasy_name: null },
        },
      }),
    } as unknown as IProofDocumentRepository;

    const uploads = {
      readObject: async () => bytes,
      getFileUrl: async () => "https://signed.example/doc-1.pdf",
    } as unknown as UploadService;

    return new VerifyProofDocumentUseCase(documents, uploads);
  }

  it("answers 404 past the retention period, like a token that never existed", async () => {
    await expect(
      useCase(new Date(Date.now() - 6 * 365 * DAY)).execute({ token: "token" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "PROOF_NOT_FOUND" });
  });

  it("still verifies a recent receipt", async () => {
    const result = await useCase(new Date(Date.now() - DAY)).execute({
      token: "token",
    });

    expect(result.intact).toBe(true);
    expect(result.url).toBe("https://signed.example/doc-1.pdf");
  });
});
