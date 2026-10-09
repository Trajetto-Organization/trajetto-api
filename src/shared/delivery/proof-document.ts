import type { DeliveryStatus } from "./delivery-rules";
import {
  documentKind,
  formatCep,
  formatCnpj,
  issuerCnpjFromKey,
  recipientDocumentLabel,
  recipientDocumentValue,
  stampLine,
  type DocumentKind,
} from "./proof-document-fields";

import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";

/**
 * What a delivery's receipt says, decided here and drawn somewhere else.
 *
 * The split is the whole point. A PDF is bytes, and an assertion against
 * rendered bytes can only say "it is 42 KB", which is true of a blank page
 * too. So every decision — which fields appear and in which order, what each
 * one says when the data is missing, the yellow stamp under the photo, what
 * the QR points at, and above all whether the page may claim legal validity —
 * lives in this pure function, and `proof-pdf-service` only draws the result.
 *
 * Layout 2 reproduces the validated model (decision 14.8,
 * docs/desenho/comprovante-modelo-validado-e-icp.md): header, legal line,
 * "Documento da entrega", "Dados da entrega", "Protocolo do documento" (GPS,
 * address, map, driver), "Comprovante digitalizado" and "Autenticação".
 *
 * Honesty rule: the signed wording (MP 2.200-2, Decreto 10.278, "Assina-se
 * com Certificado Digital ICP-Brasil", validar.iti.gov.br) is only produced
 * when the caller says the document WILL be signed with a certificate it
 * already loaded. Without one the page says it is unsigned, out loud.
 */

/** A reverse-geocoded address cached on the proof event (§5.1). */
interface GpsAddress {
  line: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
}

interface ProofDocumentSource {
  delivery: {
    id: string;
    code: string | null;

    status: DeliveryStatus;

    invoice_key: string | null;
    invoice_number: string | null;

    recipient_name: string;
    recipient_document: string | null;

    street: string;
    address_number: string | null;
    complement: string | null;
    neighborhood: string | null;
    city: string;
    uf: string;
    cep: string | null;

    delivered_at: Date | string | null;
    received_by: string | null;

    shipper: {
      name: string;
      corporate_reason?: string | null;
      cnpj?: string | null;
    } | null;
  };

  business: {
    corporate_reason: string;
    fantasy_name?: string | null;
    cnpj: string;

    /**
     * Business.timezone. The moments are printed on the company's clock and
     * labelled with it; absent or unknown, Brasília's (decision 1.1).
     */
    timezone?: string | null;
  };

  driver: { id?: string; name: string; cpf?: string | null } | null;

  route: { code: number; name: string | null } | null;

  /** The PROOF event, which is what makes this document exist at all. */
  proof: {
    /** Its event id: the geocoding cache lives on this row. */
    eventId?: string;

    /** When it happened (occurred_at ?? created_at). */
    created_at: Date | string;

    /** When the receipt photo was taken; null → created_at (§3.2). */
    photo_taken_at?: Date | string | null;

    latitude: number | null;
    longitude: number | null;

    /** Platform and version ("android 1.4.0 (42)"); not printed (§3 #21). */
    device?: string | null;

    /** The phone's Android ID (16 hex), printed as "Identificação do Celular". */
    device_id?: string | null;

    photoKey: string | null;
    signatureKey: string | null;

    gps_address?: GpsAddress | null;
    gps_address_source?: "PROVIDER" | "UNAVAILABLE" | null;
    gps_geocoded_at?: Date | string | null;
  } | null;

  /**
   * The name of the "delivered" occurrence type recorded with the proof
   * (decision 14.3), e.g. "Entrega normal". Null for proofs that predate it.
   */
  deliveredTypeName?: string | null;

  /**
   * The latest STATUS_CHANGE to FAILED, for a FAILED delivery. A manual
   * change clears delivered_at, so without a blocking occurrence this is the
   * only record of when and why the delivery ended.
   */
  failure?: {
    occurred_at: Date | string;
    reasonName: string | null;
    /**
     * Set when the change was the tower approving a blocking occurrence:
     * that occurrence, not the change, is then the fact.
     */
    occurrenceId?: string | null;
  } | null;

  /** The problems the delivery had (NOT_DELIVERED category only). */
  occurrences: Array<{
    created_at: Date | string;
    typeName: string;
    blocking: boolean;
    description: string | null;

    latitude?: number | null;
    longitude?: number | null;
    photoKey?: string | null;
  }>;
}

interface ProofField {
  label: string;
  value: string;
}

/** Fields drawn side by side on one row ("Nº do documento" · "Tipo"). */
type ProofLine = ProofField[];

/** Rows drawn together; blocks are separated by a blank line. */
interface ProofBlock {
  /** A bold line over the block ("Entregador", "GPS coletado…"). */
  heading?: string;

  lines: ProofLine[];

  /** Plain lines under the fields (an address, a missing-GPS note). */
  notes?: string[];

  /** Fields drawn after the notes (the CEP under the GPS address). */
  trailing?: ProofLine[];
}

interface ProofSection {
  title: string;
  blocks: ProofBlock[];
}

/** How the document will leave the server, decided before it is drawn. */
type ProofSigningIntent =
  | {
      status: "SIGNED";
      /** From the certificate (its CN), never from configuration. */
      signer: { name: string; cnpj: string | null };
    }
  | { status: "UNSIGNED" };

/** Who answers for the document in the authentication text. */
interface ProofIssuer {
  /** "TRAJETTO" in "A TRAJETTO (…) garante…". */
  brand: string;

  /** "Trajetto Sistemas Ltda", from configuration. */
  legalName: string;

  /** From configuration; null means the sentence leaves it out. */
  cnpj: string | null;
}

interface ProofDocumentModel {
  layoutVersion: 2;

  signed: boolean;

  /** PDF /Title and /Author. */
  info: { title: string; author: string };

  header: { title: string; number: string };

  /** The italic line under the header. */
  legalLine: string;

  sections: {
    document: ProofSection;
    delivery: ProofSection;
    protocol: ProofSection;
  };

  /** Where the map goes, when there is a fix to centre it on. */
  map: { latitude: number; longitude: number } | null;

  receipt: {
    title: string;
    photoKey: string | null;
    signatureKey: string | null;

    /** The yellow line under the photo. */
    stamp: string;

    missingPhoto: string;
    signatureLabel: string;
  };

  authentication: {
    title: string;
    paragraphs: Array<{ text: string; bold?: boolean }>;
    steps: string[];

    /** What the main QR encodes. */
    qrUrl: string;

    /** Printed under the text, clickable; null when the QR already is it. */
    verificationLine: { label: string; url: string } | null;
  };

  /** The public /verificar page for this document's token. */
  verificationUrl: string;
}

const MISSING = "Não informado";

const ITI_VALIDATOR_URL = "https://validar.iti.gov.br";

const DEFAULT_ISSUER: ProofIssuer = {
  brand: "TRAJETTO",
  legalName: "Trajetto Sistemas Ltda",
  cnpj: null,
};

/**
 * How each Brazilian zone is named on the paper. São Paulo's clock is the one
 * people call "horário de Brasília"; the others by the city of the zone.
 */
const ZONE_NAMES: Record<string, string> = {
  "America/Noronha": "Fernando de Noronha",
  "America/Belem": "Belém",
  "America/Fortaleza": "Fortaleza",
  "America/Recife": "Recife",
  "America/Araguaina": "Araguaína",
  "America/Maceio": "Maceió",
  "America/Bahia": "Salvador",
  "America/Sao_Paulo": "Brasília",
  "America/Campo_Grande": "Campo Grande",
  "America/Cuiaba": "Cuiabá",
  "America/Santarem": "Santarém",
  "America/Porto_Velho": "Porto Velho",
  "America/Boa_Vista": "Boa Vista",
  "America/Manaus": "Manaus",
  "America/Eirunepe": "Eirunepé",
  "America/Rio_Branco": "Rio Branco",
};

/** "UTC-3" at that instant. An ASCII hyphen: the PDF's Helvetica is WinAnsi. */
function utcOffset(date: Date, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";

  return name.replace(/^GMT/, "UTC").replace(/−/g, "-");
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "horário de Manaus, UTC-4": the clock a moment is printed on. `value` only
 * picks the instant the offset is read at.
 */
function formatZone(
  value: Date | string | null | undefined,
  zone?: string | null,
): string {
  const timeZone = resolveTimeZone(zone);
  const at = toDate(value) ?? new Date();

  const place = ZONE_NAMES[timeZone] ?? timeZone;

  return `horário de ${place}, ${utcOffset(at, timeZone)}`;
}

/**
 * "16/09/2026 09:30:00 (horário de Manaus, UTC-4)": on the company's clock and
 * saying which one — a carrier in Cuiabá reading an unlabelled Brasília time
 * takes it for its own and is an hour off.
 */
function formatMoment(
  value: Date | string | null | undefined,
  zone?: string | null,
  options: { labelled?: boolean } = {},
): string {
  const date = toDate(value);

  if (!date) return MISSING;

  const printed = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: resolveTimeZone(zone),
  })
    .format(date)
    .replace(",", "");

  if (options.labelled === false) return printed;

  return `${printed} (${formatZone(date, zone)})`;
}

/** "13:30:26" on the company's clock. */
function formatClock(date: Date, zone?: string | null): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeStyle: "medium",
    timeZone: resolveTimeZone(zone),
  }).format(date);
}

function formatAddress(delivery: ProofDocumentSource["delivery"]): string {
  const street = [delivery.street, delivery.address_number]
    .filter(Boolean)
    .join(", ");

  const parts = [
    street,
    delivery.complement,
    delivery.neighborhood,
    `${delivery.city} - ${delivery.uf}`,
    formatCep(delivery.cep),
  ].filter((part): part is string => Boolean(part && part.trim()));

  return parts.join(", ");
}

function orMissing(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : MISSING;
}

/**
 * The driver's CPF, with only its middle six digits (GAP1-8, ADR 0009).
 *
 * The receipt is public by construction: its verification link is printed on
 * it and needs no login. The model prints the full CPF; the masking stays
 * until the owner revisits ADR 0009 (design §11 item 1). Anything that is not
 * eleven digits is not printed at all.
 */
function maskCpf(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");

  if (digits.length !== 11) return MISSING;

  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

function hasFix(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    // (0,0) is a phone that had no fix and sent zeros, not a place.
    !(latitude === 0 && longitude === 0)
  );
}

/** The GPS-derived address, as the model prints it: one line, then the CEP. */
function gpsAddressLines(address: GpsAddress): string[] {
  const place = [address.line, address.district]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");

  const head = [place, address.city, address.state]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" - ");

  return head ? [head] : [];
}

/** What the document is about: the proof, or the blocking occurrence. */
interface Fact {
  moment: Date | null;
  photoMoment: Date | null;
  latitude: number | null;
  longitude: number | null;
  photoKey: string | null;
  signatureKey: string | null;
  occurrence: string;
}

function factOf(source: ProofDocumentSource): Fact {
  const { delivery, proof } = source;

  if (delivery.status === "FAILED") {
    // The most recent blocking occurrence is what ended the delivery (§3.3).
    const blocking = [...source.occurrences]
      .filter((occurrence) => occurrence.blocking)
      .sort(
        (left, right) =>
          (toDate(right.created_at)?.getTime() ?? 0) -
          (toDate(left.created_at)?.getTime() ?? 0),
      )[0];

    // A manual change to FAILED (panel) is the record when there is no
    // blocking occurrence or when it came after the latest one: a delivery
    // reopened and failed again must not print the stale occurrence. A change
    // caused by approving an occurrence points at it and never wins.
    const candidate = source.failure ?? null;
    const failure =
      candidate &&
      !candidate.occurrenceId &&
      (!blocking ||
        (toDate(candidate.occurred_at)?.getTime() ?? 0) >
          (toDate(blocking.created_at)?.getTime() ?? 0))
        ? candidate
        : null;
    const occurrence = failure ? undefined : blocking;

    const moment =
      toDate(occurrence?.created_at) ??
      toDate(failure?.occurred_at) ??
      toDate(delivery.delivered_at);

    return {
      moment,
      photoMoment: moment,
      latitude: occurrence?.latitude ?? null,
      longitude: occurrence?.longitude ?? null,
      photoKey: occurrence?.photoKey ?? null,
      signatureKey: null,
      occurrence: occurrence?.typeName ?? (failure?.reasonName?.trim() || MISSING),
    };
  }

  const moment = toDate(proof?.created_at) ?? toDate(delivery.delivered_at);

  return {
    moment,
    photoMoment: toDate(proof?.photo_taken_at) ?? moment,
    latitude: proof?.latitude ?? null,
    longitude: proof?.longitude ?? null,
    photoKey: proof?.photoKey ?? null,
    signatureKey: proof?.signatureKey ?? null,
    // Never "Entrega normal" without a type of that name (§3 #15).
    occurrence: source.deliveredTypeName?.trim() || "Entrega realizada",
  };
}

/**
 * The receipt, as a structure.
 *
 * `verificationBaseUrl` and `signing` are passed in rather than read from env
 * so the function stays pure: what the QR points at and whether the page may
 * claim validity are part of what the document says, and a test has to be
 * able to assert both.
 */
function buildProofDocumentModel(
  source: ProofDocumentSource,
  props: {
    verificationBaseUrl: string;
    verificationToken: string;
    signing?: ProofSigningIntent;
    issuer?: Partial<ProofIssuer>;
  },
): ProofDocumentModel {
  const { delivery, business, driver } = source;

  const signing: ProofSigningIntent = props.signing ?? { status: "UNSIGNED" };
  const signed = signing.status === "SIGNED";

  const issuer: ProofIssuer = {
    brand: props.issuer?.brand?.trim() || DEFAULT_ISSUER.brand,
    legalName: props.issuer?.legalName?.trim() || DEFAULT_ISSUER.legalName,
    cnpj: props.issuer?.cnpj?.trim() || null,
  };

  const zone = business.timezone;
  const failed = delivery.status === "FAILED";
  const fact = factOf(source);

  const { kind, number } = documentKind(delivery);
  const headerNumber =
    delivery.invoice_number?.trim() ||
    delivery.code?.trim() ||
    delivery.id.slice(0, 8);

  // ------------------------------------------------- Documento da entrega
  const shipperCnpj =
    delivery.shipper?.cnpj?.replace(/\D/g, "") ||
    issuerCnpjFromKey(delivery.invoice_key);

  const recipientDocument = recipientDocumentValue(delivery.recipient_document);

  const documentSection: ProofSection = {
    title: "Documento da entrega:",
    blocks: [
      {
        lines: [
          [
            { label: "Nº do documento", value: orMissing(number) },
            { label: "Tipo", value: kind },
          ],
          [
            {
              label: "Nº da rota",
              value: source.route ? String(source.route.code) : MISSING,
            },
          ],
        ],
      },
      {
        lines: [
          [
            {
              label: "Razão Social Emitente",
              value: orMissing(
                delivery.shipper?.corporate_reason || delivery.shipper?.name,
              ),
            },
          ],
          [{ label: "CNPJ", value: orMissing(shipperCnpj) }],
        ],
      },
      {
        lines: [
          [
            {
              label: "Razão Social / Nome do Transportador",
              value: business.corporate_reason,
            },
          ],
          [{ label: "CNPJ", value: business.cnpj.replace(/\D/g, "") || MISSING }],
        ],
      },
      {
        lines: [
          [
            {
              label: "Razão Social Cliente / Destinatário",
              value: delivery.recipient_name,
            },
          ],
          [
            recipientDocument
              ? {
                  label: recipientDocumentLabel(recipientDocument),
                  value: recipientDocument,
                }
              : { label: "CNPJ/CPF", value: MISSING },
          ],
        ],
      },
    ],
  };

  // ---------------------------------------------------- Dados da entrega
  const street = [delivery.street, delivery.address_number]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");

  const placeLine: ProofLine = [
    { label: "Município", value: delivery.city },
    { label: "UF", value: delivery.uf },
  ];

  const cepDigits = (delivery.cep ?? "").replace(/\D/g, "");

  if (cepDigits) placeLine.push({ label: "CEP", value: cepDigits });

  const deliveryLines: ProofLine[] = [
    [
      {
        label: "Data",
        value: fact.moment
          ? businessDateKey(fact.moment, resolveTimeZone(zone))
          : MISSING,
      },
    ],
    [
      {
        label: "Hora",
        // The zone suffix is the one deliberate difference from the model:
        // a carrier in MT or AM would read a bare Brasília time wrong (1.1).
        value: fact.moment
          ? `${formatClock(fact.moment, zone)} (${formatZone(fact.moment, zone)})`
          : MISSING,
      },
    ],
    [
      {
        label: "Logradouro",
        value:
          [street, delivery.complement?.trim()].filter(Boolean).join(" - ") ||
          MISSING,
      },
    ],
    placeLine,
    [{ label: "Ocorrência", value: fact.occurrence }],
  ];

  if (delivery.received_by?.trim()) {
    deliveryLines.push([
      { label: "Recebido por", value: delivery.received_by.trim() },
    ]);
  }

  const deliverySection: ProofSection = {
    title: failed ? "Dados da ocorrência:" : "Dados da entrega:",
    blocks: [{ lines: deliveryLines }],
  };

  // ------------------------------------------------ Protocolo do documento
  const gps = hasFix(fact.latitude, fact.longitude);

  const gpsBlock: ProofBlock = {
    heading: failed
      ? "GPS coletado no local da ocorrência:"
      : "GPS coletado no local da entrega:",
    lines: [],
    notes: [],
  };

  if (gps) {
    gpsBlock.lines.push([
      // Seven places, point decimal, as the model prints them.
      { label: "Latitude", value: (fact.latitude as number).toFixed(7) },
      { label: "Longitude", value: (fact.longitude as number).toFixed(7) },
    ]);

    // The reverse-geocoded address belongs to the proof's own fix; for a
    // failed delivery the fix is the occurrence's, which has no cache.
    const address =
      !failed && source.proof?.gps_address_source === "PROVIDER"
        ? source.proof.gps_address ?? null
        : null;

    const lines = address ? gpsAddressLines(address) : [];

    if (address && lines.length > 0) {
      gpsBlock.notes!.push(...lines);

      const cep = formatCep(address.cep);
      if (cep) gpsBlock.trailing = [[{ label: "CEP", value: cep }]];
    } else {
      // Never presented as if it came from the GPS (§3 #17).
      gpsBlock.notes!.push(
        "Endereço cadastrado da entrega (geocodificação indisponível):",
        formatAddress(delivery),
      );
    }
  } else {
    gpsBlock.notes!.push(
      failed
        ? "GPS não capturado no momento da ocorrência."
        : "GPS não capturado no momento da entrega.",
    );
  }

  const driverBlock: ProofBlock = {
    heading: "Entregador",
    lines: [
      [{ label: "Nome", value: orMissing(driver?.name) }],
      [{ label: "Doc. de identificação", value: maskCpf(driver?.cpf) }],
      [
        {
          label: "Identificação do Celular",
          value: failed ? MISSING : orMissing(source.proof?.device_id),
        },
      ],
    ],
  };

  const protocolSection: ProofSection = {
    title: "Protocolo do documento:",
    blocks: [gpsBlock, driverBlock],
  };

  // ------------------------------------------------- the stamp and the QR
  const stamp = stampLine({
    brand: "Trajetto",
    moment: fact.photoMoment
      ? formatMoment(fact.photoMoment, zone, { labelled: false })
      : MISSING,
    latitude: gps ? fact.latitude : null,
    longitude: gps ? fact.longitude : null,
    driverName: driver?.name,
    kind,
    number,
  });

  const base = props.verificationBaseUrl.replace(/\/+$/, "");
  const verificationUrl = `${base}/verificar/${props.verificationToken}`;

  const subject = failed ? "Registro de Ocorrência" : "Comprovação de Entrega";

  const header = {
    title: signed
      ? `Certificado Digital ${failed ? "do" : "da"} ${subject}`
      : failed
        ? "Registro de Ocorrência"
        : "Comprovante de Entrega",
    number: headerNumber,
  };

  const legalLine = signed
    ? `Documento de ${failed ? "registro da ocorrência" : "comprovação da entrega"} com validade jurídica conforme os termos do Art. 10, § 1º, da Medida Provisória nº 2.200-2, de 24 de agosto de 2001 e Decreto nº 10.278, de 18 de março de 2020. Assinado com Certificado Digital (normas ICP-Brasil).`
    : "Documento sem assinatura digital ICP-Brasil. Reúne as informações registradas no momento da entrega; a integridade do arquivo pode ser conferida pelo código de verificação. Não afirma a validade jurídica prevista na MP nº 2.200-2/2001.";

  const authentication: ProofDocumentModel["authentication"] = signed
    ? {
        title: "Autenticação:",
        paragraphs: [
          {
            text: `A ${issuer.brand} (${
              signing.signer.cnpj
                ? `${signing.signer.name} – CNPJ ${formatCnpj(signing.signer.cnpj)}`
                : signing.signer.name
            }) garante a autenticidade e integridade deste documento e declara que as informações neste documento são fidedignas às informações capturadas e recebidas em campo. Assina-se com Certificado Digital ICP-Brasil.`,
          },
          {
            text: "Ateste a autenticidade deste documento, de acordo com termos do DECRETO Nº 10.278, DE 18 DE MARÇO DE 2020:",
            bold: true,
          },
        ],
        steps: [
          `A. Acesse o site: ${ITI_VALIDATOR_URL} ou leia o qrcode ao lado.`,
          "B. Submeta este arquivo pdf para consultar validade jurídica deste documento.",
        ],
        qrUrl: ITI_VALIDATOR_URL,
        // Whoever holds the paper cannot submit "this file": /verificar is
        // where they download the original to submit (design §6.6, §11.2).
        verificationLine: { label: "Original e integridade:", url: verificationUrl },
      }
    : {
        title: "Autenticação:",
        paragraphs: [
          {
            text: `A ${issuer.brand} (${
              issuer.cnpj
                ? `${issuer.legalName} – CNPJ ${formatCnpj(issuer.cnpj)}`
                : issuer.legalName
            }) gerou este documento a partir das informações capturadas e recebidas em campo.`,
          },
          {
            text: "Este documento não foi assinado digitalmente.",
            bold: true,
          },
        ],
        steps: [
          "Para conferir se o arquivo é o original gerado pela Trajetto, acesse o endereço abaixo ou leia o QR ao lado.",
        ],
        qrUrl: verificationUrl,
        verificationLine: { label: "Conferir:", url: verificationUrl },
      };

  return {
    layoutVersion: 2,
    signed,

    info: {
      title: signed
        ? `${failed ? "Registro de ocorrência" : "Comprovante de entrega"} assinado`
        : `${failed ? "Registro de ocorrência" : "Comprovante de entrega"} (sem assinatura digital)`,
      author: "Trajetto",
    },

    header,
    legalLine,

    sections: {
      document: documentSection,
      delivery: deliverySection,
      protocol: protocolSection,
    },

    map: gps
      ? { latitude: fact.latitude as number, longitude: fact.longitude as number }
      : null,

    receipt: {
      title: "Comprovante digitalizado:",
      photoKey: fact.photoKey,
      signatureKey: fact.signatureKey,
      stamp,
      missingPhoto: fact.photoKey
        ? "A imagem do canhoto não está mais disponível no armazenamento."
        : "Nenhuma foto foi registrada.",
      signatureLabel: "Assinatura do recebedor (em tela)",
    },

    authentication,
    verificationUrl,
  };
}

/** Every string the model would put on the page, in drawing order. */
function proofDocumentTexts(model: ProofDocumentModel): string[] {
  const fromSection = (section: ProofSection): string[] => [
    section.title,
    ...section.blocks.flatMap((block) => [
      ...(block.heading ? [block.heading] : []),
      ...block.lines.flatMap((line) =>
        line.flatMap((field) => [`${field.label}:`, field.value]),
      ),
      ...(block.notes ?? []),
      ...(block.trailing ?? []).flatMap((line) =>
        line.flatMap((field) => [`${field.label}:`, field.value]),
      ),
    ]),
  ];

  return [
    model.header.title,
    model.header.number,
    model.legalLine,
    ...fromSection(model.sections.document),
    ...fromSection(model.sections.delivery),
    ...fromSection(model.sections.protocol),
    model.receipt.title,
    model.receipt.stamp,
    model.authentication.title,
    ...model.authentication.paragraphs.map((paragraph) => paragraph.text),
    ...model.authentication.steps,
    ...(model.authentication.verificationLine
      ? [
          model.authentication.verificationLine.label,
          model.authentication.verificationLine.url,
        ]
      : []),
  ];
}

export {
  ITI_VALIDATOR_URL,
  MISSING,
  buildProofDocumentModel,
  formatAddress,
  formatMoment,
  formatZone,
  maskCpf,
  proofDocumentTexts,
};
export type {
  DocumentKind,
  GpsAddress,
  ProofBlock,
  ProofDocumentModel,
  ProofDocumentSource,
  ProofField,
  ProofIssuer,
  ProofLine,
  ProofSection,
  ProofSigningIntent,
};
