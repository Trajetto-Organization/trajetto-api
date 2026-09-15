import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from "./delivery-rules";

/**
 * What a delivery's receipt says, decided here and drawn somewhere else.
 *
 * The split is the whole point. A PDF is bytes, and bytes are the one thing a
 * test cannot read: an assertion against a rendered page can only say "it is
 * 42 KB", which is true of a blank page too. So every decision — which fields
 * appear, what each one says when the data is missing, what the stamp over the
 * receipt photo reads, what the QR points at — lives in this pure function,
 * and `proof-pdf-service` only draws the result.
 *
 * The document asserts FACTS THAT WERE CAPTURED and claims nothing more. There
 * is no ICP-Brasil signature in this slice and the page says so out loud: a
 * receipt that implied legal validity it does not have would be worse than one
 * that implies none, because somebody would rely on it in front of a judge.
 */
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

    shipper: { name: string; cnpj?: string | null } | null;
  };

  business: {
    corporate_reason: string;
    fantasy_name?: string | null;
    cnpj: string;
  };

  driver: { name: string; cpf?: string | null } | null;

  route: { code: number; name: string | null } | null;

  /** The PROOF event, which is what makes this document exist at all. */
  proof: {
    created_at: Date | string;

    latitude: number | null;
    longitude: number | null;

    /** Which phone recorded it — support is regularly asked to tell two apart. */
    device: string | null;

    photoKey: string | null;
    signatureKey: string | null;
  } | null;

  /** How it ended, when it ended badly or with a note. */
  occurrences: Array<{
    created_at: Date | string;
    typeName: string;
    blocking: boolean;
    description: string | null;
  }>;
}

interface ProofField {
  label: string;
  value: string;
}

interface ProofSection {
  title: string;
  fields: ProofField[];
}

interface ProofDocumentModel {
  /** Printed at the top; the carrier is who answers for this document. */
  headline: string;
  subtitle: string;

  sections: ProofSection[];

  /** Burned over the receipt photo, one line per entry. */
  stamp: string[];

  photoKey: string | null;
  signatureKey: string | null;

  /** Rendered as the QR and printed under it, so it survives a bad scan. */
  verificationUrl: string;

  /** The sentence about what this document is and is not. */
  disclaimer: string;
}

const MISSING = "Não informado";

/** Dates the way the person holding the paper writes them. */
function formatMoment(value: Date | string | null | undefined): string {
  if (!value) return MISSING;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return MISSING;

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function formatCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  if (latitude === null || latitude === undefined) return MISSING;
  if (longitude === null || longitude === undefined) return MISSING;

  // Six decimals is about ten centimetres — past the accuracy of any phone,
  // and the precision people expect to be able to paste into a map.
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function formatAddress(delivery: ProofDocumentSource["delivery"]): string {
  const street = [delivery.street, delivery.address_number]
    .filter(Boolean)
    .join(", ");

  const parts = [
    street,
    delivery.complement,
    delivery.neighborhood,
    `${delivery.city} — ${delivery.uf}`,
    delivery.cep,
  ].filter((part): part is string => Boolean(part && part.trim()));

  return parts.join(" · ");
}

function orMissing(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : MISSING;
}

/**
 * The receipt, as a structure.
 *
 * `verificationBaseUrl` is passed in rather than read from env here so the
 * function stays pure: what the QR points at is part of what the document
 * says, and a test has to be able to assert it.
 */
function buildProofDocumentModel(
  source: ProofDocumentSource,
  props: { verificationBaseUrl: string; verificationToken: string },
): ProofDocumentModel {
  const { delivery, business, driver, route, proof } = source;

  const carrier = business.fantasy_name?.trim() || business.corporate_reason;

  const sections: ProofSection[] = [
    {
      title: "Documento fiscal",
      fields: [
        { label: "Chave da NF-e", value: orMissing(delivery.invoice_key) },
        { label: "Número da NF", value: orMissing(delivery.invoice_number) },
        { label: "Pedido", value: orMissing(delivery.code) },
        {
          label: "Embarcador",
          value: orMissing(delivery.shipper?.name),
        },
        {
          label: "CNPJ do embarcador",
          value: orMissing(delivery.shipper?.cnpj),
        },
        { label: "Transportadora", value: carrier },
        { label: "CNPJ da transportadora", value: business.cnpj },
      ],
    },
    {
      title: "Destinatário",
      fields: [
        { label: "Nome", value: delivery.recipient_name },
        {
          label: "Documento",
          value: orMissing(delivery.recipient_document),
        },
        { label: "Endereço declarado", value: formatAddress(delivery) },
      ],
    },
    {
      title: "Entrega",
      fields: [
        {
          label: "Status",
          value: DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status,
        },
        { label: "Rota", value: route ? `#${route.code}` : MISSING },
        { label: "Nome da rota", value: orMissing(route?.name) },
        {
          label: "Data e hora da comprovação",
          value: formatMoment(proof?.created_at ?? delivery.delivered_at),
        },
        { label: "Recebido por", value: orMissing(delivery.received_by) },
        {
          // Next to the declared address on purpose: the two disagreeing is
          // the single most useful thing this document can show, and putting
          // them on different pages hides it.
          label: "Coordenadas capturadas",
          value: formatCoordinates(proof?.latitude, proof?.longitude),
        },
      ],
    },
    {
      title: "Entregador",
      fields: [
        { label: "Nome", value: orMissing(driver?.name) },
        { label: "Documento", value: orMissing(driver?.cpf) },
        { label: "Dispositivo", value: orMissing(proof?.device) },
      ],
    },
  ];

  if (source.occurrences.length > 0) {
    sections.push({
      title: "Ocorrências",
      fields: source.occurrences.map((occurrence) => ({
        label: formatMoment(occurrence.created_at),
        value:
          `${occurrence.typeName}${occurrence.blocking ? " (impeditiva)" : ""}` +
          (occurrence.description ? ` — ${occurrence.description}` : ""),
      })),
    });
  }

  // Burned over the photo rather than printed beside it: a receipt picture
  // circulates on its own the moment somebody screenshots it, and a caption
  // that stays behind is a caption that stops being part of the evidence.
  const stamp = [
    carrier,
    formatMoment(proof?.created_at ?? delivery.delivered_at),
    formatCoordinates(proof?.latitude, proof?.longitude),
    delivery.invoice_number
      ? `NF ${delivery.invoice_number}`
      : orMissing(delivery.code),
    delivery.recipient_name,
  ];

  const base = props.verificationBaseUrl.replace(/\/+$/, "");

  return {
    headline: "Comprovante de entrega",
    subtitle: `${carrier} · ${formatMoment(
      proof?.created_at ?? delivery.delivered_at,
    )}`,

    sections,
    stamp,

    photoKey: proof?.photoKey ?? null,
    signatureKey: proof?.signatureKey ?? null,

    verificationUrl: `${base}/verificar/${props.verificationToken}`,

    disclaimer:
      "Este documento reúne informações registradas no momento da entrega e " +
      "permite conferir a integridade do arquivo pelo código de verificação. " +
      "Não possui assinatura digital ICP-Brasil e não afirma validade " +
      "jurídica própria.",
  };
}

export { MISSING, buildProofDocumentModel, formatAddress, formatMoment };
export type {
  ProofDocumentModel,
  ProofDocumentSource,
  ProofField,
  ProofSection,
};
