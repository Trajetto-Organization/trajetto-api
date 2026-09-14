import { describe, expect, it } from "vitest";

import { parseNFeXml, NFeParseError } from "@/shared/delivery/nfe-parser";

const ACCESS_KEY = "35240612345678000199550010000012341000012345";

/** Same layout the Sefaz portal hands out: nfeProc wrapping NFe + protNFe. */
const buildNFe = (overrides: { det?: string; dest?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${ACCESS_KEY}1" versao="4.00">
      <ide>
        <nNF>1234</nNF>
        <dhEmi>2026-08-18T09:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>12.345.678/0001-99</CNPJ>
        <xNome>Industria Alimentos LTDA</xNome>
      </emit>
      ${
        overrides.dest ??
        `<dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Central ME</xNome>
        <email>compras@mercadocentral.com.br</email>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr>
          <nro>450</nro>
          <xCpl>Galpao 2</xCpl>
          <xBairro>Centro</xBairro>
          <xMun>Campinas</xMun>
          <UF>sp</UF>
          <CEP>13010000</CEP>
          <fone>1932334455</fone>
        </enderDest>
      </dest>`
      }
      ${
        overrides.det ??
        `<det nItem="1">
        <prod>
          <xProd>Caixa de leite integral 1L</xProd>
          <qCom>120.0000</qCom>
          <uCom>CX</uCom>
          <vUnCom>4.5000</vUnCom>
        </prod>
      </det>`
      }
    </infNFe>
  </NFe>
  <protNFe>
    <infProt>
      <chNFe>${ACCESS_KEY}</chNFe>
    </infProt>
  </protNFe>
</nfeProc>`;

describe("NF-e parser", () => {
  it("extracts the delivery from a complete invoice", () => {
    const parsed = parseNFeXml(buildNFe());

    expect(parsed.invoice_key).toBe(ACCESS_KEY);
    expect(parsed.invoice_number).toBe("1234");

    expect(parsed.recipient_name).toBe("Mercado Central ME");
    expect(parsed.recipient_document).toBe("98765432000188");

    expect(parsed.city).toBe("Campinas");
    expect(parsed.street).toBe("Rua das Palmeiras");
    expect(parsed.address_number).toBe("450");
    expect(parsed.neighborhood).toBe("Centro");
  });

  it("normalizes UF to uppercase and strips punctuation from documents", () => {
    const parsed = parseNFeXml(buildNFe());

    expect(parsed.uf).toBe("SP");
    // The issuer is the shipper — matched by CNPJ, so punctuation must go.
    expect(parsed.issuer_cnpj).toBe("12345678000199");
    expect(parsed.issuer_name).toBe("Industria Alimentos LTDA");
    expect(parsed.cep).toBe("13010000");
    expect(parsed.recipient_telephone).toBe("1932334455");
  });

  it("keeps the 44-digit key without the NFe prefix of the Id attribute", () => {
    const parsed = parseNFeXml(buildNFe());

    expect(parsed.invoice_key).toHaveLength(44);
    expect(parsed.invoice_key.startsWith("NFe")).toBe(false);
  });

  it("reads a single item as one item, not as characters", () => {
    const parsed = parseNFeXml(buildNFe());

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toEqual({
      description: "Caixa de leite integral 1L",
      quantity: 120,
      unit: "CX",
      unit_value: 4.5,
    });
  });

  it("reads repeated det tags as multiple items", () => {
    const parsed = parseNFeXml(
      buildNFe({
        det: `<det nItem="1">
          <prod><xProd>Item A</xProd><qCom>2</qCom><uCom>UN</uCom><vUnCom>10.00</vUnCom></prod>
        </det>
        <det nItem="2">
          <prod><xProd>Item B</xProd><qCom>5</qCom><uCom>CX</uCom><vUnCom>3.50</vUnCom></prod>
        </det>`,
      }),
    );

    expect(parsed.items.map((item) => item.description)).toEqual([
      "Item A",
      "Item B",
    ]);
  });

  it("parses the issue date", () => {
    const parsed = parseNFeXml(buildNFe());

    expect(parsed.issued_at?.toISOString()).toBe("2026-08-18T12:30:00.000Z");
  });

  it("accepts a bare NFe without the authorization protocol", () => {
    const bare = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
      <infNFe Id="NFe${ACCESS_KEY}" versao="4.00">
        <ide><nNF>7</nNF></ide>
        <dest>
          <xNome>Cliente Sem Protocolo</xNome>
          <enderDest>
            <xLgr>Av Brasil</xLgr><xMun>Santos</xMun><UF>SP</UF>
          </enderDest>
        </dest>
      </infNFe>
    </NFe>`;

    const parsed = parseNFeXml(bare);

    expect(parsed.invoice_key).toBe(ACCESS_KEY);
    expect(parsed.items).toEqual([]);
  });

  it("falls back to the city when the recipient has no name", () => {
    const parsed = parseNFeXml(
      buildNFe({
        dest: `<dest>
          <enderDest>
            <xLgr>Estrada Rural</xLgr><xMun>Itu</xMun><UF>SP</UF>
          </enderDest>
        </dest>`,
      }),
    );

    expect(parsed.recipient_name).toBe("Destinatário em Itu");
  });
});

describe("NF-e parser rejections", () => {
  it("rejects an empty file", () => {
    expect(() => parseNFeXml("   ")).toThrow(NFeParseError);
  });

  it("rejects a file that is not an NF-e", () => {
    const notAnInvoice = `<procEventoNFe><evento><infEvento><chNFe>${ACCESS_KEY}</chNFe></infEvento></evento></procEventoNFe>`;

    expect(() => parseNFeXml(notAnInvoice)).toThrow(/não parece ser uma NF-e/);
  });

  it("rejects an invoice without a recipient", () => {
    const noRecipient = `<NFe><infNFe Id="NFe${ACCESS_KEY}"><ide><nNF>1</nNF></ide></infNFe></NFe>`;

    expect(() => parseNFeXml(noRecipient)).toThrow(/destinatário/);
  });

  it("rejects an incomplete delivery address", () => {
    const noStreet = buildNFe({
      dest: `<dest>
        <xNome>Sem Rua</xNome>
        <enderDest><xMun>Recife</xMun><UF>PE</UF></enderDest>
      </dest>`,
    });

    expect(() => parseNFeXml(noStreet)).toThrow(/endereço do destinatário/);
  });
});
