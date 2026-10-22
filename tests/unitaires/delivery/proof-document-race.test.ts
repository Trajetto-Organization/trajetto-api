import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { GetProofDocumentUseCase } from "@/modules/delivery/usecases/get-proof-document/get-proof-document-usecase";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { ProofDocumentSource } from "@/shared/delivery/proof-document";
import type { ProofDocumentModel } from "@/shared/delivery/proof-document";
import type { User } from "@/modules/user/dtos/user-dto";

import {
  noLocationProviders,
  unsignedSigning,
} from "../../support/proof-services";

/**
 * Two people opening the same receipt at once (IDEMP-12).
 *
 * Every render drew its own token, printed it in the QR, PUT the PDF under a
 * key FIXED per delivery, and only then upserted the row — whose update
 * branch keeps the first token and overwrites the hash. With two renders in
 * flight, the object in the bucket and the row describing it came from
 * different renders: the public page then called a genuine receipt either
 * "not intact" (the hash of the bytes is not the row's) or "not found" (the
 * QR printed on it carries a token no row has). Nothing about pdfkit makes two
 * renders byte-identical, so even two regenerations with the same token
 * diverged. A regeneration whose PUT landed and whose save failed did too.
 *
 * The render is stubbed with bytes that carry the verification URL they were
 * rendered for, so "which token is printed on the stored object" is a string
 * search.
 */
let renders = 0;

vi.mock("@/shared/services/proof-pdf-renderer", () => ({
  renderProofPdfOffThread: async (model: ProofDocumentModel) => {
    renders += 1;

    const bytes = Buffer.from(`%PDF-stub ${model.verificationUrl} #${renders}`);

    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
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
      shipper: { name: "Distribuidora Norte", cnpj: "11222333000199" },
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11222333000166",
    },
    driver: { name: "João Motorista", cpf: "12345678900" },
    route: null,
    proof: null,
    occurrences: [],
  } as unknown as ProofDocumentSource;
}

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { gate, release };
}

function makeContext() {
  const users = new InMemoryUserRepository();
  users.user.push({
    id: USER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  const documents = new InMemoryProofDocumentRepository();
  documents.addSource(BUSINESS, source());

  const bucket = new Map<string, Buffer>();

  const uploads = {
    readObject: async () => null,
    putObject: async (key: string, body: Buffer) => {
      bucket.set(key, body);
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

  const open = (regenerate?: boolean) =>
    useCase.execute({
      userId: USER,
      businessId: BUSINESS,
      deliveryId: DELIVERY,
      regenerate,
    });

  /** What the public page would find: the row, and the bytes it points at. */
  const published = () => {
    const [row] = documents.documents;
    const bytes = bucket.get(row.storage_key);

    return { row, bytes };
  };

  return { documents, uploads, bucket, open, published };
}

function expectConsistent(
  published: ReturnType<ReturnType<typeof makeContext>["published"]>,
) {
  const { row, bytes } = published;

  expect(bytes, "the row points at an object that exists").toBeDefined();

  // "Íntegro": the hash of the stored bytes is the row's.
  expect(createHash("sha256").update(bytes!).digest("hex")).toBe(row.sha256);

  // "Encontrado": the QR printed on the stored bytes is the row's token.
  expect(bytes!.toString()).toContain(`/verificar/${row.verification_token}`);
}

describe("two first readers of the same receipt", () => {
  it("leave one document whose object, hash and token agree", async () => {
    const context = makeContext();

    // The first reader's upload stalls until the second has finished
    // everything, then lands on top of it.
    const firstPut = deferred();
    const put = context.uploads.putObject;
    let puts = 0;

    context.uploads.putObject = async (key, body) => {
      puts += 1;
      if (puts === 1) await firstPut.gate;
      return put(key, body);
    };

    const first = context.open();
    const second = context.open();

    await second;
    firstPut.release();
    await first;

    expect(context.documents.documents).toHaveLength(1);
    expectConsistent(context.published());
  });
});

describe("two regenerations at once", () => {
  it("leave the row describing the object it points at", async () => {
    const context = makeContext();

    await context.open();

    // The first regeneration's save stalls until the second has finished.
    const firstSave = deferred();
    const save = context.documents.save.bind(context.documents);
    let saves = 0;

    context.documents.save = async (data) => {
      saves += 1;
      if (saves === 1) await firstSave.gate;
      return save(data);
    };

    const first = context.open(true);
    const second = context.open(true);

    await second;
    firstSave.release();
    await first;

    expectConsistent(context.published());
  });
});

describe("a regeneration whose save fails after its upload", () => {
  it("leaves the previous document intact", async () => {
    const context = makeContext();

    await context.open();

    context.documents.save = async () => {
      throw new Error("connection reset");
    };

    await expect(context.open(true)).rejects.toThrow();

    expectConsistent(context.published());
  });
});
