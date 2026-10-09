import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { GetProofDocumentUseCase } from "@/modules/delivery/usecases/get-proof-document/get-proof-document-usecase";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type {
  ProofDocumentModel,
  ProofDocumentSource,
} from "@/shared/delivery/proof-document";
import type { User } from "@/modules/user/dtos/user-dto";

import { noLocationProviders, unsignedSigning } from "../../support/proof-services";

/**
 * Whose receipt it is, in the in-memory twin (review of the twin's parity).
 *
 * The real `loadSource` reads `where: { id: deliveryId, businessId }`. The
 * twin only checked that a businessId was passed at all, so a use case run
 * through it handed company A's receipt to a user of company B, asking under
 * B's own path, where Postgres answers nothing and the route a 404.
 *
 * The render is stubbed: nothing here is about the PDF's bytes.
 */
vi.mock("@/shared/services/proof-pdf-renderer", () => ({
  renderProofPdfOffThread: async (model: ProofDocumentModel) => {
    const bytes = Buffer.from(`%PDF-stub ${model.verificationUrl}`);

    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  },
}));

const OWNER = "018f0000-0000-7000-8000-00000000000b";
const OTHER = "018f0000-0000-7000-8000-00000000000c";

const OWNER_USER = "018f0000-0000-7000-8000-0000000000a1";
const OTHER_USER = "018f0000-0000-7000-8000-0000000000a2";

const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

function source(): ProofDocumentSource {
  return {
    delivery: {
      id: DELIVERY,
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: null,
      invoice_number: "12345",
      recipient_name: "Padaria Central Ltda",
      recipient_document: null,
      street: "Praça da Sé",
      address_number: "100",
      complement: null,
      neighborhood: "Sé",
      city: "São Paulo",
      uf: "SP",
      cep: "01001000",
      delivered_at: new Date("2026-09-16T13:30:00.000Z"),
      received_by: "Maria Souza",
      shipper: null,
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11222333000166",
    },
    driver: null,
    route: null,
    proof: null,
    occurrences: [],
  };
}

function makeContext() {
  const users = new InMemoryUserRepository();

  users.user.push(
    { id: OWNER_USER, role: "BUSINESS_ADMIN", businessId: OWNER } as User,
    { id: OTHER_USER, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
  );

  const documents = new InMemoryProofDocumentRepository();

  documents.addSource(OWNER, source());

  const stored: string[] = [];

  const uploads = {
    readObject: async () => null,
    putObject: async (key: string) => {
      stored.push(key);
    },
    getFileUrl: async (key: string) => `https://bucket.exemplo/${key}`,
  };

  const useCase = new GetProofDocumentUseCase(
    users,
    documents,
    uploads as never,
    unsignedSigning(),
    noLocationProviders(),
  );

  return { documents, stored, useCase };
}

describe("the receipt's source in the twin", () => {
  it("is absent for another company, as the real `where` makes it", async () => {
    const { documents } = makeContext();

    expect(await documents.loadSource(DELIVERY, OTHER)).toBeNull();
    expect(await documents.loadSource(DELIVERY, "")).toBeNull();

    expect((await documents.loadSource(DELIVERY, OWNER))?.delivery.id).toBe(DELIVERY);
  });

  it("gives another company's user a 404 under their own path, and renders nothing", async () => {
    const { documents, stored, useCase } = makeContext();

    await expect(
      useCase.execute({ userId: OTHER_USER, businessId: OTHER, deliveryId: DELIVERY }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });

    expect(stored).toEqual([]);
    expect(documents.documents).toEqual([]);
  });

  it("still produces the receipt for the company that owns the delivery", async () => {
    const { documents, stored, useCase } = makeContext();

    const result = await useCase.execute({
      userId: OWNER_USER,
      businessId: OWNER,
      deliveryId: DELIVERY,
    });

    expect(result.document.businessId).toBe(OWNER);
    expect(stored).toHaveLength(1);
    expect(documents.documents).toHaveLength(1);
  });

  it("refuses to hand one company's existing document row to another", async () => {
    // The real createIfAbsent re-reads the winner WITH the businessId after
    // the unique violation and rethrows when it is not there.
    const { documents } = makeContext();

    const row = {
      deliveryId: DELIVERY,
      businessId: OWNER,
      storage_key: "proof-documents/a.pdf",
      sha256: "a".repeat(64),
      verification_token: "b".repeat(64),
      size_bytes: 10,
      ...DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
    };

    await documents.createIfAbsent(row);

    await expect(
      documents.createIfAbsent({ ...row, businessId: OTHER }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe("a session whose user row is gone", () => {
  it("answers 404 USER_NOT_FOUND, with its code (decision 11.3)", async () => {
    const { useCase } = makeContext();

    await expect(
      useCase.execute({
        userId: "018f0000-0000-7000-8000-0000000000ff",
        businessId: OWNER,
        deliveryId: DELIVERY,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});
