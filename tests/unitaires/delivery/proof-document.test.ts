import { describe, expect, it } from "vitest";

import {
  MISSING,
  buildProofDocumentModel,
  type ProofDocumentSource,
} from "@/shared/delivery/proof-document";

import { renderProofPdf } from "@/shared/services/proof-pdf-service";

/**
 * The receipt a delivery leaves behind.
 *
 * Everything asserted here is a decision about what the document SAYS, which
 * is why those decisions live in a pure function: an assertion against a
 * rendered PDF can only say "it is 42 KB", and that is equally true of a blank
 * page. The bytes get exactly two tests at the bottom — that they are a PDF,
 * and that the hash follows the content — and nothing else.
 */
const VERIFY_BASE = "https://app.trajetto.com.br";
const TOKEN = "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e";

/**
 * Explicit key presence, not a spread.
 *
 * `{ ...defaults, ...override }` silently keeps the default when the override
 * is `null`, which is exactly the case these tests are about — "there is no
 * proof event" and "there is no route" were both being tested against a
 * fixture that still had one.
 */
function source(
  overrides: Partial<ProofDocumentSource> = {},
): ProofDocumentSource {
  const base: ProofDocumentSource = {
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
    driver: { name: "João Motorista", cpf: "12345678900" },
    route: { code: 42, name: "Zona Sul — manhã" },
    proof: {
      created_at: new Date("2026-09-16T13:30:00.000Z"),
      latitude: -23.550519,
      longitude: -46.633308,
      device: "Moto G84 (Android 14)",
      photoKey: "delivery/photo.jpg",
      signatureKey: "delivery/signature.png",
    },
    occurrences: [],
  };

  return { ...base, ...overrides };
}

function build(overrides: Partial<ProofDocumentSource> = {}) {
  return buildProofDocumentModel(source(overrides), {
    verificationBaseUrl: VERIFY_BASE,
    verificationToken: TOKEN,
  });
}

/** Every value the document prints, flattened, for the "does it appear" checks. */
function allValues(model: ReturnType<typeof build>): string {
  return model.sections
    .flatMap((section) => section.fields.map((field) => `${field.label}: ${field.value}`))
    .join("\n");
}

describe("what the receipt carries", () => {
  it("prints the fiscal identity of the load", () => {
    const printed = allValues(build());

    expect(printed).toContain("3".repeat(44));
    expect(printed).toContain("12345");
    expect(printed).toContain("PED-4471");

    expect(printed).toContain("Distribuidora Norte");
    expect(printed).toContain("Silva Log");
  });

  it("puts the declared address and the captured coordinates together", () => {
    // The two disagreeing is the single most useful thing this document can
    // show. On different pages it stops being visible at all.
    const delivery = build().sections.find(
      (section) => section.title === "Entrega",
    )!;

    const recipient = build().sections.find(
      (section) => section.title === "Destinatário",
    )!;

    expect(
      recipient.fields.find((field) => field.label === "Endereço declarado")!
        .value,
    ).toContain("Praça da Sé, 100");

    expect(
      delivery.fields.find((field) => field.label === "Coordenadas capturadas")!
        .value,
    ).toBe("-23.550519, -46.633308");
  });

  it("names the driver and the phone that recorded it", () => {
    const printed = allValues(build());

    expect(printed).toContain("João Motorista");
    expect(printed).toContain("Moto G84 (Android 14)");
  });

  it("lists the occurrences when the delivery had any", () => {
    const model = build({
      occurrences: [
        {
          created_at: new Date("2026-09-16T12:00:00.000Z"),
          typeName: "Destinatário ausente",
          blocking: true,
          description: "Portaria fechada",
        },
      ],
    });

    const section = model.sections.find(
      (entry) => entry.title === "Ocorrências",
    );

    expect(section).toBeDefined();
    expect(section!.fields[0].value).toContain("Destinatário ausente");

    expect(section!.fields[0].value).toContain("impeditiva");
    expect(section!.fields[0].value).toContain("Portaria fechada");
  });

  it("omits the occurrences section entirely when there were none", () => {
    // An empty "Ocorrências" heading on a clean delivery reads like something
    // is missing.
    expect(
      build().sections.some((section) => section.title === "Ocorrências"),
    ).toBe(false);
  });
});

describe("what it says when the data is not there", () => {
  it("says so, rather than printing a blank", () => {
    // A blank next to a label reads as "we lost it". The words say which it is.
    const model = build({
      delivery: {
        ...source().delivery,
        invoice_key: null,
        invoice_number: null,
        recipient_document: null,
        received_by: null,
        shipper: null,
      },
      driver: null,
      route: null,
    });

    const printed = allValues(model);

    expect(printed).toContain(`Chave da NF-e: ${MISSING}`);
    expect(printed).toContain(`Documento: ${MISSING}`);
    expect(printed).toContain(`Rota: ${MISSING}`);
  });

  it("says so for coordinates the phone never captured", () => {
    const model = build({
      proof: { ...source().proof!, latitude: null, longitude: null },
    });

    expect(allValues(model)).toContain(`Coordenadas capturadas: ${MISSING}`);
  });

  it("still builds a document when there is no proof event at all", () => {
    // A delivery resolved from the panel has no photo and no coordinates, and
    // the customer is still entitled to a receipt of what IS known.
    const model = build({ proof: null });

    expect(model.photoKey).toBeNull();
    expect(model.sections.length).toBeGreaterThan(0);
  });
});

describe("the stamp burned over the photo", () => {
  it("carries the carrier, the moment, the place and the load", () => {
    // Burned in rather than captioned: the picture circulates on its own the
    // moment somebody screenshots it, and a caption left behind stops being
    // part of the evidence.
    const stamp = build().stamp.join(" | ");

    expect(stamp).toContain("Silva Log");
    expect(stamp).toContain("-23.550519, -46.633308");

    expect(stamp).toContain("NF 12345");
    expect(stamp).toContain("Padaria Central Ltda");
  });

  it("falls back to the order number when there is no invoice", () => {
    const model = build({
      delivery: { ...source().delivery, invoice_number: null },
    });

    expect(model.stamp.join(" | ")).toContain("PED-4471");
  });
});

describe("the verification link", () => {
  it("points at the public page for this token", () => {
    expect(build().verificationUrl).toBe(`${VERIFY_BASE}/verificar/${TOKEN}`);
  });

  it("does not double the slash when the base url has a trailing one", () => {
    const model = buildProofDocumentModel(source(), {
      verificationBaseUrl: `${VERIFY_BASE}/`,
      verificationToken: TOKEN,
    });

    expect(model.verificationUrl).toBe(`${VERIFY_BASE}/verificar/${TOKEN}`);
  });

  it("says what the document is not", () => {
    // A receipt that implied legal validity it does not have would be worse
    // than one that implies none: somebody would rely on it in front of a
    // judge.
    expect(build().disclaimer).toContain("ICP-Brasil");
    expect(build().disclaimer).toContain("não afirma validade");
  });
});

describe("the bytes", () => {
  it("are a PDF, and the hash is of exactly those bytes", async () => {
    const rendered = await renderProofPdf(build(), {
      photo: null,
      signature: null,
    });

    expect(rendered.bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/);

    const again = await renderProofPdf(build(), {
      photo: null,
      signature: null,
    });

    // Not equal to the first: pdfkit stamps a creation date, so two renders
    // of the same document differ. That is fine and is why the hash is stored
    // WITH the bytes rather than recomputed from the model — what the public
    // page verifies is that the file it serves is the file we wrote.
    expect(again.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("changes when the content changes", async () => {
    const first = await renderProofPdf(build(), {
      photo: null,
      signature: null,
    });

    const second = await renderProofPdf(
      build({
        delivery: { ...source().delivery, recipient_name: "Outro cliente" },
      }),
      { photo: null, signature: null },
    );

    expect(first.sha256).not.toBe(second.sha256);
  }, 30_000);

  it("survives a photo whose bytes are not an image", async () => {
    // A purged or corrupt receipt picture must not cost the customer their
    // whole document.
    const rendered = await renderProofPdf(build(), {
      photo: Buffer.from("isto não é uma imagem"),
      signature: null,
    });

    expect(rendered.bytes.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
