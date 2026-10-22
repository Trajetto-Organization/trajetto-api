import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import type { ProofDocumentSource } from "@/shared/delivery/proof-document";

import { VerifyProofDocumentUseCase } from "@/modules/delivery/usecases/verify-proof-document/verify-proof-document-usecase";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { UploadService } from "@/shared/services/upload-service";

/**
 * The clock the public verification page shows (review of DLVP-PROOF-4).
 *
 * The PDF prints its moments in the carrier's zone, labelled. The page
 * printed them in a fixed São Paulo zone, so for a carrier in Manaus the
 * paper and the page disagreed by an hour about the same delivery. The
 * summary now carries the zone the PDF uses.
 *
 * Run through the in-memory twin, whose token lookup returned the whole
 * document source instead of the real query's shape: the use case read no
 * recipient and no carrier from it.
 */
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";
const TOKEN =
  "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e";

const bytes = Buffer.from("%PDF-1.7 comprovante");

function source(timezone?: string | null): ProofDocumentSource {
  return {
    delivery: {
      id: DELIVERY,
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: null,
      invoice_number: "12345",
      recipient_name: "Padaria Central Ltda",
      recipient_document: null,
      street: "Rua",
      address_number: null,
      complement: null,
      neighborhood: null,
      city: "Manaus",
      uf: "AM",
      cep: null,
      delivered_at: new Date("2026-09-17T03:30:00.000Z"),
      received_by: "Maria Souza",
      shipper: null,
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11222333000166",
      ...(timezone === undefined ? {} : { timezone }),
    },
    driver: null,
    route: null,
    proof: null,
    occurrences: [],
  };
}

async function verify(timezone?: string | null) {
  const documents = new InMemoryProofDocumentRepository();

  documents.addSource("018f0000-0000-7000-8000-00000000000b", source(timezone));
  documents.documents.push({
    id: "doc-1",
    deliveryId: DELIVERY,
    businessId: "018f0000-0000-7000-8000-00000000000b",
    storage_key: "proof-documents/doc-1.pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    verification_token: TOKEN,
    size_bytes: bytes.length,
    version: 1,
    generated_at: new Date(),
    ...DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
  });

  const uploads = {
    readObject: async () => bytes,
    getFileUrl: async () => "https://signed.example/doc-1.pdf",
  } as unknown as UploadService;

  return new VerifyProofDocumentUseCase(documents, uploads).execute({
    token: TOKEN,
  });
}

describe("the public verification summary", () => {
  it("carries the carrier's zone, the one its PDF prints the moments in", async () => {
    const { summary, intact } = await verify("America/Manaus");

    expect(intact).toBe(true);
    expect(summary.timeZone).toBe("America/Manaus");

    // The twin answers the real query's shape: the recipient and the carrier
    // come through.
    expect(summary.recipientName).toBe("Padaria Central Ltda");
    expect(summary.carrierName).toBe("Silva Log");
    expect(summary.receivedBy).toBe("Maria Souza");
  });

  it("falls back to Brasília for a company with no zone or an unknown one, like the PDF", async () => {
    expect((await verify(undefined)).summary.timeZone).toBe(
      "America/Sao_Paulo",
    );
    expect((await verify("")).summary.timeZone).toBe("America/Sao_Paulo");
    expect((await verify("Not/A_Zone")).summary.timeZone).toBe(
      "America/Sao_Paulo",
    );
  });
});
