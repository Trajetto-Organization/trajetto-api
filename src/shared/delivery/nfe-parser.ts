import { XMLParser } from "fast-xml-parser";

/**
 * NF-e (modelo 55) XML → the delivery a carrier has to make.
 *
 * Kept pure and framework-free so it can be unit-tested against real files:
 * the parser never touches the database, never decides business rules, it
 * only answers "what does this fiscal document say?".
 *
 * The layout it reads is the national NF-e schema: `nfeProc > NFe > infNFe`
 * (a file exported from the Sefaz portal) or a bare `NFe > infNFe` (what
 * some ERPs hand out before the authorization protocol is attached).
 */

interface NFeItem {
  description: string;
  quantity: number;
  unit: string | null;
  unit_value: number | null;
}

interface NFeParsedData {
  /** 44-digit access key — the identity of the invoice and our dedupe anchor. */
  invoice_key: string;
  invoice_number: string | null;
  issued_at: Date | null;

  /** Issuer = the cargo owner, which is the shipper in a carrier's world. */
  issuer_cnpj: string | null;
  issuer_name: string | null;

  recipient_name: string;
  recipient_document: string | null;
  recipient_email: string | null;
  recipient_telephone: string | null;

  cep: string | null;
  city: string;
  uf: string;
  street: string;
  address_number: string | null;
  complement: string | null;
  neighborhood: string | null;

  items: NFeItem[];
}

class NFeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NFeParseError";
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Everything as string: fiscal fields are text (leading zeros in CEP and
  // access keys must survive), and numbers are converted where they matter.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/** The XML is a tree of unknown shape until proven otherwise. */
type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as XmlNode;
  }

  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  if (typeof value === "number") return String(value);

  return null;
}

/** A tag that appears once is an object; twice or more, an array. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function onlyDigits(value: string | null): string | null {
  if (value === null) return null;

  const digits = value.replace(/\D/g, "");
  return digits === "" ? null : digits;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The access key lives in `infNFe@Id` prefixed with "NFe" ("NFe" + 44
 * digits). Some ERPs also repeat it in `protNFe > infProt > chNFe`.
 */
function extractAccessKey(infNFe: XmlNode, root: XmlNode): string | null {
  const idAttribute = asText(infNFe["@_Id"]);
  const fromId = onlyDigits(idAttribute);

  if (fromId && fromId.length === 44) return fromId;

  const protNFe = asNode(root["protNFe"]);
  const infProt = protNFe ? asNode(protNFe["infProt"]) : null;

  const fromProtocol = onlyDigits(asText(infProt?.["chNFe"]));

  if (fromProtocol && fromProtocol.length === 44) return fromProtocol;

  return null;
}

function parseIssuedAt(ide: XmlNode | null): Date | null {
  // dhEmi is ISO with timezone (NF-e 3.10+); dEmi is the legacy date-only.
  const raw = asText(ide?.["dhEmi"]) ?? asText(ide?.["dEmi"]);

  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseItems(det: unknown): NFeItem[] {
  return asArray(det).flatMap((entry) => {
    const prod = asNode(asNode(entry)?.["prod"]);

    if (!prod) return [];

    const description = asText(prod["xProd"]);

    if (!description) return [];

    return [
      {
        description,
        quantity: toNumber(asText(prod["qCom"])) ?? 1,
        unit: asText(prod["uCom"]),
        unit_value: toNumber(asText(prod["vUnCom"])),
      },
    ];
  });
}

/**
 * Parses one NF-e XML document.
 *
 * Throws NFeParseError with a message the operator can act on — an import
 * screen has to say *why* a file was rejected, not just that it failed.
 */
function parseNFeXml(xml: string): NFeParsedData {
  if (!xml || xml.trim() === "") {
    throw new NFeParseError("O arquivo XML está vazio.");
  }

  let document: XmlNode;

  try {
    document = parser.parse(xml) as XmlNode;
  } catch {
    throw new NFeParseError(
      "Não foi possível ler o arquivo: o conteúdo não é um XML válido.",
    );
  }

  // nfeProc wraps the NFe plus its authorization protocol; a bare NFe is
  // also accepted (ERPs often export it before the protocol arrives).
  const nfeProc = asNode(document["nfeProc"]);
  const root = nfeProc ?? document;

  const nfe = asNode(root["NFe"]);
  const infNFe = nfe ? asNode(nfe["infNFe"]) : null;

  if (!infNFe) {
    throw new NFeParseError(
      "O XML não parece ser uma NF-e (elemento infNFe não encontrado). " +
        "Envie o arquivo da nota, não o do evento ou do cancelamento.",
    );
  }

  const invoiceKey = extractAccessKey(infNFe, root);

  if (!invoiceKey) {
    throw new NFeParseError(
      "Não foi possível localizar a chave de acesso (44 dígitos) na nota.",
    );
  }

  const dest = asNode(infNFe["dest"]);

  if (!dest) {
    throw new NFeParseError(
      "A nota não possui destinatário, então não descreve uma entrega.",
    );
  }

  const address = asNode(dest["enderDest"]);

  if (!address) {
    throw new NFeParseError(
      "A nota não possui endereço de entrega do destinatário.",
    );
  }

  // xNome is optional for rural/foreign recipients; the address always
  // carries a city, and the city is what an operator recognizes.
  const recipientName = asText(dest["xNome"]);
  const city = asText(address["xMun"]);

  const uf = asText(address["UF"]);
  const street = asText(address["xLgr"]);

  if (!city || !uf || !street) {
    throw new NFeParseError(
      "O endereço do destinatário está incompleto (rua, cidade ou UF ausente).",
    );
  }

  const ide = asNode(infNFe["ide"]);
  const emit = asNode(infNFe["emit"]);

  return {
    invoice_key: invoiceKey,
    invoice_number: asText(ide?.["nNF"]),
    issued_at: parseIssuedAt(ide),

    issuer_cnpj: onlyDigits(asText(emit?.["CNPJ"])),
    issuer_name: asText(emit?.["xNome"]) ?? asText(emit?.["xFant"]),

    recipient_name: recipientName ?? `Destinatário em ${city}`,
    recipient_document:
      onlyDigits(asText(dest["CNPJ"])) ?? onlyDigits(asText(dest["CPF"])),
    recipient_email: asText(dest["email"]),
    recipient_telephone: onlyDigits(asText(address["fone"])),

    cep: onlyDigits(asText(address["CEP"])),
    city,
    uf: uf.toUpperCase(),
    street,
    address_number: asText(address["nro"]),
    complement: asText(address["xCpl"]),
    neighborhood: asText(address["xBairro"]),

    items: parseItems(infNFe["det"]),
  };
}

export { parseNFeXml, NFeParseError };
export type { NFeParsedData, NFeItem };
