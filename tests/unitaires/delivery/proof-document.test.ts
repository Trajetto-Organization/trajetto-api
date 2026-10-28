import { describe, expect, it } from "vitest";

import {
  MISSING,
  buildProofDocumentModel,
  proofDocumentTexts,
  type ProofDocumentModel,
  type ProofDocumentSource,
  type ProofSection,
  type ProofSigningIntent,
} from "@/shared/delivery/proof-document";

import { renderProofPdf } from "@/shared/services/proof-pdf-service";

/** An RGBA PNG header, an IDAT that does not inflate, an IEND. */
function corruptPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([
      length,
      Buffer.from(type, "latin1"),
      data,
      Buffer.alloc(4),
    ]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from("definitivamente não é deflate")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The receipt in the validated model's layout (decision 14.8,
 * docs/desenho/comprovante-modelo-validado-e-icp.md §1.1 and §3).
 *
 * Everything asserted here is a decision about what the document SAYS, which
 * is why those decisions live in a pure function. Where the words land on
 * the page is proof-pdf-layout.test.ts; the signature is proof-signing.
 */
const VERIFY_BASE = "https://app.trajetto.com.br";
const TOKEN = "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e";

/** NF-e key, model 55, issuer 31358035000120 (valid check digits). */
const NFE_KEY = "3226093135803500012055002000045515100045515".padEnd(44, "0");

// Signed by a certificate whose chain reached an ICP-Brasil root.
const SIGNED: ProofSigningIntent = {
  status: "SIGNED",
  signer: { name: "TRAJETTO SISTEMAS LTDA", cnpj: "11222333000181" },
  icpBrasil: true,
};

/** Explicit key presence, not a spread: a null override must stay null. */
function source(
  overrides: Partial<ProofDocumentSource> = {},
): ProofDocumentSource {
  const base: ProofDocumentSource = {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: NFE_KEY,
      invoice_number: "45515",
      recipient_name: "Supermercado Cabral Ltda",
      recipient_document: "30.970.502/0001-06",
      street: "Rua Alberto de Oliveira Santos",
      address_number: "494",
      complement: null,
      neighborhood: "Soteco",
      city: "Vila Velha",
      uf: "ES",
      cep: "29106-100",
      delivered_at: new Date("2026-09-30T16:30:26.000Z"),
      received_by: null,
      shipper: {
        name: "Multipla",
        corporate_reason: "Multipla Distribuidora de Alimentos Ltda",
        cnpj: null,
      },
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11.222.333/0001-66",
    },
    driver: { name: "Rogerio Viana Bezerra", cpf: "09797417778" },
    route: { code: 5696, name: "Zona Sul" },
    proof: {
      eventId: "018f0000-0000-7000-8000-0000000000ee",
      created_at: new Date("2026-09-30T16:30:26.000Z"),
      photo_taken_at: new Date("2026-09-30T16:30:08.000Z"),
      latitude: -20.3502181,
      longitude: -40.3038332,
      device: "android 1.4.0 (42)",
      device_id: "23be03c084165505",
      photoKey: "delivery/photo.jpg",
      signatureKey: "delivery/signature.png",
      gps_address: {
        line: "Rua Alberto de Oliveira Santos, 117",
        district: "Soteco",
        city: "Vila Velha",
        state: "Espírito Santo",
        cep: "29106100",
      },
      gps_address_source: "PROVIDER",
    },
    deliveredTypeName: "Entrega normal",
    occurrences: [],
  };

  return { ...base, ...overrides };
}

function build(
  overrides: Partial<ProofDocumentSource> = {},
  signing: ProofSigningIntent = { status: "UNSIGNED" },
  issuer?: { brand?: string; legalName?: string; cnpj?: string | null },
): ProofDocumentModel {
  return buildProofDocumentModel(source(overrides), {
    verificationBaseUrl: VERIFY_BASE,
    verificationToken: TOKEN,
    signing,
    issuer,
  });
}

/** "Label: value" of every field of a section, in order. */
function fields(section: ProofSection): string[] {
  return section.blocks.flatMap((block) =>
    [...block.lines, ...(block.trailing ?? [])].flatMap((line) =>
      line.map((field) => `${field.label}: ${field.value}`),
    ),
  );
}

function value(section: ProofSection, label: string): string | undefined {
  return section.blocks
    .flatMap((block) => [...block.lines, ...(block.trailing ?? [])].flat())
    .find((field) => field.label === label)?.value;
}

describe("the sections, in the model's order and words", () => {
  it("reproduces 'Documento da entrega' field by field", () => {
    const model = build();

    expect(model.sections.document.title).toBe("Documento da entrega:");
    expect(fields(model.sections.document)).toEqual([
      "Nº do documento: 45515",
      "Tipo: NFe",
      "Nº da rota: 5696",
      "Razão Social Emitente: Multipla Distribuidora de Alimentos Ltda",
      // The shipper has no CNPJ: the issuer's, embedded in the key.
      "CNPJ: 31358035000120",
      "Razão Social / Nome do Transportador: Transportes Silva Ltda",
      "CNPJ: 11222333000166",
      "Razão Social Cliente / Destinatário: Supermercado Cabral Ltda",
      "CNPJ: 30970502000106",
    ]);

    // Number and type share a row, as in the model.
    expect(
      model.sections.document.blocks[0].lines[0].map((field) => field.label),
    ).toEqual(["Nº do documento", "Tipo"]);
  });

  it("reproduces 'Dados da entrega' with the company's date and clock", () => {
    const model = build();

    expect(model.sections.delivery.title).toBe("Dados da entrega:");
    expect(fields(model.sections.delivery)).toEqual([
      "Data: 2026-09-30",
      "Hora: 13:30:26 (horário de Brasília, UTC-3)",
      "Logradouro: Rua Alberto de Oliveira Santos, 494",
      "Município: Vila Velha",
      "UF: ES",
      "CEP: 29106100",
      "Ocorrência: Entrega normal",
    ]);
  });

  it("reproduces 'Protocolo do documento': GPS, its address, CEP, then the driver", () => {
    const model = build();
    const [gps, driver] = model.sections.protocol.blocks;

    expect(model.sections.protocol.title).toBe("Protocolo do documento:");
    expect(gps.heading).toBe("GPS coletado no local da entrega:");
    expect(gps.lines).toEqual([
      [
        { label: "Latitude", value: "-20.3502181" },
        { label: "Longitude", value: "-40.3038332" },
      ],
    ]);
    expect(gps.notes).toEqual([
      "Rua Alberto de Oliveira Santos, 117, Soteco - Vila Velha - Espírito Santo",
    ]);
    expect(gps.trailing).toEqual([[{ label: "CEP", value: "29106-100" }]]);

    expect(driver.heading).toBe("Entregador");
    expect(fields({ title: "", blocks: [driver] })).toEqual([
      "Nome: Rogerio Viana Bezerra",
      // Masked: the document is public by its token (ADR 0009, design §11.1).
      "Doc. de identificação: ***.974.177-**",
      "Identificação do Celular: 23be03c084165505",
    ]);

    expect(model.map).toEqual({
      latitude: -20.3502181,
      longitude: -40.3038332,
    });
  });

  it("puts every text in the model's sequence", () => {
    const texts = proofDocumentTexts(build({}, SIGNED));
    const order = [
      "Certificado Digital da Comprovação de Entrega",
      "45515",
      "Documento da entrega:",
      "Dados da entrega:",
      "Protocolo do documento:",
      "Entregador",
      "Comprovante digitalizado:",
      "Autenticação:",
    ].map((text) => texts.indexOf(text));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("adds 'Recebido por' after Ocorrência only when somebody was named", () => {
    expect(value(build().sections.delivery, "Recebido por")).toBeUndefined();

    const named = build({
      delivery: { ...source().delivery, received_by: " Maria Souza " },
    });

    expect(fields(named.sections.delivery).slice(-2)).toEqual([
      "Ocorrência: Entrega normal",
      "Recebido por: Maria Souza",
    ]);
  });
});

describe("the yellow stamp under the photo", () => {
  it("uses the photo's moment, 4 places with a comma, the driver in capitals and the document", () => {
    // 13:30:08 is the camera; the delivery itself is 13:30:26 — the model
    // prints them apart and so do we.
    expect(build().receipt.stamp).toBe(
      "Trajetto - 30/09/2026 13:30:08  -20,3502, -40,3038  ROGERIO VIANA BEZERRA  NFe 45515",
    );
  });

  it("falls back to the delivery moment without a photo time, and says when there was no GPS", () => {
    const model = build({
      proof: {
        ...source().proof!,
        photo_taken_at: null,
        latitude: null,
        longitude: null,
      },
    });

    expect(model.receipt.stamp).toBe(
      "Trajetto - 30/09/2026 13:30:26  GPS indisponível  ROGERIO VIANA BEZERRA  NFe 45515",
    );
  });
});

describe("what it says when the data is not there", () => {
  it("says 'Não informado' for each gap, never a blank or an invented value", () => {
    const model = build({
      delivery: {
        ...source().delivery,
        invoice_key: null,
        invoice_number: null,
        recipient_document: null,
        cep: null,
        shipper: null,
      },
      driver: null,
      route: null,
      proof: { ...source().proof!, device_id: null },
    });

    expect(fields(model.sections.document)).toEqual([
      "Nº do documento: PED-4471",
      "Tipo: Pedido",
      `Nº da rota: ${MISSING}`,
      `Razão Social Emitente: ${MISSING}`,
      `CNPJ: ${MISSING}`,
      "Razão Social / Nome do Transportador: Transportes Silva Ltda",
      "CNPJ: 11222333000166",
      "Razão Social Cliente / Destinatário: Supermercado Cabral Ltda",
      `CNPJ/CPF: ${MISSING}`,
    ]);

    // No CEP: the field leaves the row instead of printing a blank.
    expect(value(model.sections.delivery, "CEP")).toBeUndefined();

    const driver = model.sections.protocol.blocks[1];
    expect(fields({ title: "", blocks: [driver] })).toEqual([
      `Nome: ${MISSING}`,
      `Doc. de identificação: ${MISSING}`,
      `Identificação do Celular: ${MISSING}`,
    ]);
  });

  it("never invents a CNPJ: a key with bad check digits and no shipper CNPJ is 'Não informado'", () => {
    const model = build({
      delivery: {
        ...source().delivery,
        invoice_key: NFE_KEY.replace("31358035000120", "31358035000121"),
      },
    });

    expect(fields(model.sections.document)[4]).toBe(`CNPJ: ${MISSING}`);
  });

  it("prints the shipper's own CNPJ before the one in the key, and labels a CPF as such", () => {
    const model = build({
      delivery: {
        ...source().delivery,
        recipient_document: "097.974.177-78",
        shipper: { name: "Multipla", cnpj: "11.222.333/0001-81" },
      },
    });

    expect(fields(model.sections.document)).toContain("CNPJ: 11222333000181");
    expect(fields(model.sections.document)).toContain(
      "Razão Social Emitente: Multipla",
    );
    expect(fields(model.sections.document).slice(-1)).toEqual([
      "CPF: 09797417778",
    ]);
  });

  it("labels the registered address when the GPS address is unavailable, never passing it off as GPS", () => {
    for (const proof of [
      {
        ...source().proof!,
        gps_address: null,
        gps_address_source: "UNAVAILABLE" as const,
      },
      { ...source().proof!, gps_address: null, gps_address_source: null },
    ]) {
      const gps = build({ proof }).sections.protocol.blocks[0];

      expect(gps.notes).toEqual([
        "Endereço cadastrado da entrega (geocodificação indisponível):",
        "Rua Alberto de Oliveira Santos, 494, Soteco, Vila Velha - ES, 29106-100",
      ]);
      expect(gps.trailing).toBeUndefined();
    }
  });

  it("says the GPS was not captured, with no coordinates, address or map", () => {
    const model = build({
      proof: { ...source().proof!, latitude: null, longitude: null },
    });
    const gps = model.sections.protocol.blocks[0];

    expect(gps.lines).toEqual([]);
    expect(gps.notes).toEqual(["GPS não capturado no momento da entrega."]);
    expect(model.map).toBeNull();

    // (0,0) is a phone without a fix, not a place in the Atlantic.
    expect(
      build({ proof: { ...source().proof!, latitude: 0, longitude: 0 } }).map,
    ).toBeNull();
  });

  it("prints 'Entrega realizada' rather than a type nobody registered", () => {
    const model = build({ deliveredTypeName: null });

    expect(value(model.sections.delivery, "Ocorrência")).toBe(
      "Entrega realizada",
    );
  });

  it("still builds a document when there is no proof event at all", () => {
    const model = build({ proof: null });

    expect(model.receipt.photoKey).toBeNull();
    expect(model.receipt.missingPhoto).toBe("Nenhuma foto foi registrada.");
    expect(value(model.sections.delivery, "Data")).toBe("2026-09-30");
  });
});

describe("a delivery that FAILED", () => {
  const failed = () =>
    build(
      {
        delivery: { ...source().delivery, status: "FAILED" },
        occurrences: [
          {
            created_at: new Date("2026-09-30T14:00:00.000Z"),
            typeName: "Reentrega",
            blocking: false,
            description: null,
          },
          {
            created_at: new Date("2026-09-30T15:10:05.000Z"),
            typeName: "Destinatário ausente",
            blocking: true,
            description: "Portaria fechada",
            latitude: -20.31,
            longitude: -40.29,
            photoKey: "occurrences/portaria.jpg",
          },
        ],
      },
      SIGNED,
    );

  it("is the record of the blocking occurrence: its title, type, moment, GPS and photo", () => {
    const model = failed();

    expect(model.header.title).toBe(
      "Certificado Digital do Registro de Ocorrência",
    );
    expect(model.sections.delivery.title).toBe("Dados da ocorrência:");
    expect(value(model.sections.delivery, "Ocorrência")).toBe(
      "Destinatário ausente",
    );
    expect(value(model.sections.delivery, "Hora")).toBe(
      "12:10:05 (horário de Brasília, UTC-3)",
    );
    expect(model.map).toEqual({ latitude: -20.31, longitude: -40.29 });
    expect(model.receipt.photoKey).toBe("occurrences/portaria.jpg");
    expect(model.receipt.signatureKey).toBeNull();
    expect(model.receipt.stamp).toBe(
      "Trajetto - 30/09/2026 12:10:05  -20,3100, -40,2900  ROGERIO VIANA BEZERRA  NFe 45515",
    );
  });

  it("does not reuse the proof's cached address for the occurrence's different fix", () => {
    const gps = failed().sections.protocol.blocks[0];

    expect(gps.heading).toBe("GPS coletado no local da ocorrência:");
    expect(gps.notes?.[0]).toBe(
      "Endereço cadastrado da entrega (geocodificação indisponível):",
    );
  });

  it("falls back to the status change that set FAILED when no occurrence blocked it", () => {
    // Regression: a panel override clears delivered_at, so the record printed
    // "Não informado" for Data, Hora and Ocorrência despite a known reason.
    const model = build(
      {
        delivery: {
          ...source().delivery,
          status: "FAILED",
          delivered_at: null,
        },
        occurrences: [
          {
            created_at: new Date("2026-09-30T14:00:00.000Z"),
            typeName: "Reentrega",
            blocking: false,
            description: null,
          },
        ],
        failure: {
          occurred_at: new Date("2026-09-30T18:45:10.000Z"),
          reasonName: "Cliente cancelou o pedido",
        },
      },
      SIGNED,
    );

    expect(value(model.sections.delivery, "Ocorrência")).toBe(
      "Cliente cancelou o pedido",
    );
    expect(value(model.sections.delivery, "Data")).toBe("2026-09-30");
    expect(value(model.sections.delivery, "Hora")).toBe(
      "15:45:10 (horário de Brasília, UTC-3)",
    );
    expect(model.receipt.stamp).toContain("Trajetto - 30/09/2026 15:45:10");
  });

  it("prefers the blocking occurrence when it came after the status change", () => {
    const model = build(
      {
        delivery: { ...source().delivery, status: "FAILED" },
        occurrences: [
          {
            created_at: new Date("2026-09-30T15:10:05.000Z"),
            typeName: "Destinatário ausente",
            blocking: true,
            description: null,
          },
        ],
        // An earlier panel FAILED, reopened, then the driver's occurrence.
        failure: {
          occurred_at: new Date("2026-09-30T12:00:00.000Z"),
          reasonName: "Outro",
        },
      },
      SIGNED,
    );

    expect(value(model.sections.delivery, "Ocorrência")).toBe(
      "Destinatário ausente",
    );
  });

  it("prints a manual FAILED made after the blocking occurrence, not the stale occurrence", () => {
    // Regression: reported at 10:00, reopened, failed from the panel at 18:00.
    const occurrences = [
      {
        created_at: new Date("2026-09-30T13:00:00.000Z"),
        typeName: "Destinatário ausente",
        blocking: true,
        description: null,
        latitude: -20.31,
        longitude: -40.29,
      },
    ];
    const later = build(
      {
        delivery: {
          ...source().delivery,
          status: "FAILED",
          delivered_at: null,
        },
        occurrences,
        failure: {
          occurred_at: new Date("2026-09-30T21:00:00.000Z"),
          reasonName: "Cliente cancelou",
          occurrenceId: null,
        },
      },
      SIGNED,
    );

    expect(value(later.sections.delivery, "Ocorrência")).toBe(
      "Cliente cancelou",
    );
    expect(value(later.sections.delivery, "Hora")).toBe(
      "18:00:00 (horário de Brasília, UTC-3)",
    );
    expect(later.receipt.stamp).not.toContain("-20,3100");

    // The tower's approval writes a later change pointing at the occurrence.
    const approved = build(
      {
        delivery: {
          ...source().delivery,
          status: "FAILED",
          delivered_at: null,
        },
        occurrences,
        failure: {
          occurred_at: new Date("2026-09-30T13:05:00.000Z"),
          reasonName: null,
          occurrenceId: "018f0000-0000-7000-8000-0000000000aa",
        },
      },
      SIGNED,
    );

    expect(value(approved.sections.delivery, "Ocorrência")).toBe(
      "Destinatário ausente",
    );
    expect(value(approved.sections.delivery, "Hora")).toBe(
      "10:00:00 (horário de Brasília, UTC-3)",
    );
  });

  it("is titled 'Registro de Ocorrência' when unsigned", () => {
    const model = buildProofDocumentModel(
      source({ delivery: { ...source().delivery, status: "FAILED" } }),
      { verificationBaseUrl: VERIFY_BASE, verificationToken: TOKEN },
    );

    expect(model.header.title).toBe("Registro de Ocorrência");
  });
});

describe("signed and unsigned: the document never claims what it is not", () => {
  // Phrases that only a signed document may carry.
  const CLAIMS = [
    "validade jurídica conforme",
    "validar.iti",
    "Assina-se com Certificado Digital",
    "Assinado com Certificado Digital",
    "Certificado Digital da",
    "garante a autenticidade",
    "DECRETO Nº 10.278",
  ];

  it("unsigned: no claim of signature or validity, the QR goes to /verificar", () => {
    const model = build();
    const texts = proofDocumentTexts(model).join("\n");

    for (const claim of CLAIMS) expect(texts).not.toContain(claim);

    // "ICP-Brasil" only inside the sentence that denies it.
    for (const text of proofDocumentTexts(model).filter((entry) =>
      entry.includes("ICP-Brasil"),
    )) {
      expect(text).toMatch(/sem assinatura digital ICP-Brasil/);
    }

    expect(model.signed).toBe(false);
    expect(model.header.title).toBe("Comprovante de Entrega");
    expect(model.info.title).toBe(
      "Comprovante de entrega (sem assinatura digital)",
    );
    expect(model.authentication.qrUrl).toBe(
      `${VERIFY_BASE}/verificar/${TOKEN}`,
    );
    expect(texts).toContain("Este documento não foi assinado digitalmente.");
  });

  it("unsigned: names the issuer from configuration and omits a CNPJ nobody configured", () => {
    expect(build().authentication.paragraphs[0].text).toBe(
      "A TRAJETTO (Trajetto Sistemas Ltda) gerou este documento a partir das informações capturadas e recebidas em campo.",
    );

    expect(
      build({}, { status: "UNSIGNED" }, { cnpj: "11222333000181" })
        .authentication.paragraphs[0].text,
    ).toContain("(Trajetto Sistemas Ltda – CNPJ 11.222.333/0001-81)");
  });

  it("signed: the model's legal wording, the ITI QR and our /verificar link", () => {
    const model = build({}, SIGNED, { cnpj: "99999999000191" });

    expect(model.signed).toBe(true);
    expect(model.header).toEqual({
      title: "Certificado Digital da Comprovação de Entrega",
      number: "45515",
    });
    expect(model.legalLine).toBe(
      "Documento de comprovação da entrega com validade jurídica conforme os termos do Art. 10, § 1º, da Medida Provisória nº 2.200-2, de 24 de agosto de 2001 e Decreto nº 10.278, de 18 de março de 2020. Assinado com Certificado Digital (normas ICP-Brasil).",
    );
    // Name and CNPJ from the certificate, never the configured one.
    expect(model.authentication.paragraphs[0].text).toBe(
      "A TRAJETTO (TRAJETTO SISTEMAS LTDA – CNPJ 11.222.333/0001-81) garante a autenticidade e integridade deste documento e declara que as informações neste documento são fidedignas às informações capturadas e recebidas em campo. Assina-se com Certificado Digital ICP-Brasil.",
    );
    expect(proofDocumentTexts(model).join("\n")).not.toContain(
      "99.999.999/0001-91",
    );
    expect(model.authentication.steps).toEqual([
      "A. Acesse o site: https://validar.iti.gov.br ou leia o qrcode ao lado.",
      "B. Submeta este arquivo pdf para consultar validade jurídica deste documento.",
    ]);
    expect(model.authentication.qrUrl).toBe("https://validar.iti.gov.br");
    expect(model.authentication.verificationLine).toEqual({
      label: "Original e integridade:",
      url: `${VERIFY_BASE}/verificar/${TOKEN}`,
    });
    expect(model.info.title).toBe("Comprovante de entrega assinado");
  });

  it("signed by a certificate without a CNPJ: the name alone, no number invented", () => {
    const model = build(
      {},
      {
        status: "SIGNED",
        signer: { name: "EMPRESA X", cnpj: null },
        icpBrasil: true,
      },
    );

    expect(model.authentication.paragraphs[0].text).toMatch(
      /^A TRAJETTO \(EMPRESA X\) garante/,
    );
  });
});

describe("the moments it prints", () => {
  it("are the company's own clock, labelled, when it has a zone", () => {
    const model = build({
      business: { ...source().business, timezone: "America/Manaus" },
    });

    expect(value(model.sections.delivery, "Data")).toBe("2026-09-30");
    expect(value(model.sections.delivery, "Hora")).toBe(
      "12:30:26 (horário de Manaus, UTC-4)",
    );
    expect(model.receipt.stamp).toMatch(/^Trajetto - 30\/09\/2026 12:30:08 /);
  });

  it("put the date on the company's day, not UTC's", () => {
    // 02:00 UTC on the 1st is still the 30th in Manaus.
    const model = build({
      business: { ...source().business, timezone: "America/Manaus" },
      proof: {
        ...source().proof!,
        created_at: new Date("2026-10-01T02:00:00.000Z"),
      },
    });

    expect(value(model.sections.delivery, "Data")).toBe("2026-09-30");
  });

  it("fall back to Brasília for an empty or unknown zone", () => {
    for (const timezone of ["", "Not/A_Zone"]) {
      const model = build({ business: { ...source().business, timezone } });

      expect(value(model.sections.delivery, "Hora")).toBe(
        "13:30:26 (horário de Brasília, UTC-3)",
      );
    }
  });

  it("print only characters the PDF's standard font can draw", () => {
    // Helvetica in pdfkit is WinAnsi: a U+2212 minus would print as garbage.
    const model = build(
      { business: { ...source().business, timezone: "America/Rio_Branco" } },
      SIGNED,
    );

    for (const text of proofDocumentTexts(model)) {
      expect(text).toMatch(/^[\x20-\x7e\xa0-\xff–]*$/);
    }
  });
});

describe("the verification link", () => {
  it("points at the public page for this token, without a doubled slash", () => {
    expect(build().verificationUrl).toBe(`${VERIFY_BASE}/verificar/${TOKEN}`);

    const model = buildProofDocumentModel(source(), {
      verificationBaseUrl: `${VERIFY_BASE}/`,
      verificationToken: TOKEN,
    });

    expect(model.verificationUrl).toBe(`${VERIFY_BASE}/verificar/${TOKEN}`);
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
    const rendered = await renderProofPdf(build(), {
      photo: Buffer.from("isto não é uma imagem"),
      signature: null,
    });

    expect(rendered.bytes.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);

  // A valid RGBA header over a corrupted body used to kill the process from
  // inside png-js's asynchronous inflate.
  it.each(["photo", "signature"] as const)(
    "survives a %s that is a PNG only on the outside",
    async (slot) => {
      const poisoned = corruptPng();

      const rendered = await renderProofPdf(build(), {
        photo: slot === "photo" ? poisoned : null,
        signature: slot === "signature" ? poisoned : null,
      });

      expect(rendered.bytes.subarray(0, 4).toString()).toBe("%PDF");

      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    30_000,
  );
});

/**
 * The type of the record titles its proof (meeting of 14/10/2026): a
 * service order is proven like a delivery and named as what it is. PICKUP
 * keeps the delivery's wording, as before the type existed.
 */
describe("the title follows the record's type", () => {
  const delivery = source().delivery;

  it("titles a service order as one, signed or not", () => {
    const unsigned = build({
      delivery: { ...delivery, kind: "SERVICE_ORDER" },
    });
    const signed = build(
      { delivery: { ...delivery, kind: "SERVICE_ORDER" } },
      SIGNED,
    );

    expect(unsigned.header.title).toBe("Comprovante de Ordem de Serviço");
    expect(unsigned.info.title).toBe(
      "Comprovante de ordem de serviço (sem assinatura digital)",
    );
    expect(signed.header.title).toBe(
      "Certificado Digital da Comprovação de Ordem de Serviço",
    );
    expect(signed.legalLine).toMatch(
      /^Documento de comprovação da ordem de serviço com validade jurídica/,
    );
  });

  it("keeps the delivery's title for a delivery, a pickup and a row without a type", () => {
    for (const kind of ["DELIVERY", "PICKUP", undefined] as const) {
      const model = build({ delivery: { ...delivery, kind } });

      expect(model.header.title).toBe("Comprovante de Entrega");
    }
  });

  it("keeps the occurrence record's title for a FAILED service order", () => {
    const model = build({
      delivery: { ...delivery, kind: "SERVICE_ORDER", status: "FAILED" },
    });

    expect(model.header.title).toBe("Registro de Ocorrência");
  });
});

/**
 * The legal statement needs a certificate whose chain reached ICP-Brasil
 * (icp-brasil-chain.ts). Signed by one outside the chain, the page says it
 * is signed and nothing more: no MP 2.200-2, no ITI validator.
 */
describe("signed outside the ICP-Brasil chain", () => {
  const OUTSIDE: ProofSigningIntent = {
    status: "SIGNED",
    signer: { name: "TRAJETTO TESTE", cnpj: null },
    icpBrasil: false,
  };

  it("claims no legal validity and leads to our own check, not the ITI's", () => {
    const model = build({}, OUTSIDE);
    const texts = proofDocumentTexts(model).join("\n");

    expect(model.signed).toBe(true);
    expect(model.icpBrasil).toBe(false);
    expect(model.header.title).toBe("Comprovante de Entrega");
    expect(model.info.title).toBe(
      "Comprovante de entrega assinado (sem cadeia ICP-Brasil)",
    );
    expect(model.legalLine).toContain(
      "não pertence à cadeia ICP-Brasil validada",
    );
    expect(texts).not.toContain("com validade jurídica conforme");
    expect(texts).not.toContain("Assina-se com Certificado Digital ICP-Brasil");
    expect(texts).not.toContain("validar.iti.gov.br");
    expect(model.authentication.qrUrl).toBe(model.verificationUrl);
  });

  it("reads an intent without the chain verdict as outside it", () => {
    const model = build(
      {},
      { status: "SIGNED", signer: { name: "TRAJETTO TESTE", cnpj: null } },
    );

    expect(model.icpBrasil).toBe(false);
    expect(model.legalLine).not.toContain("com validade jurídica conforme");
  });
});
