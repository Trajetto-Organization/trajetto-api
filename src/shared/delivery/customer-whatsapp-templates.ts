import type { DeliveryMessageTopic } from "@/modules/delivery/repositories/IDelivery-message-template-repository";
import {
  fillTemplateBody,
  fitTemplateParameters,
  type WhatsAppTemplateDefinition,
  type WhatsAppTemplateVariable,
} from "@/shared/notifications/whatsapp-templates";

/**
 * The four messages a carrier sends the person waiting for a delivery over
 * WhatsApp (plan of 02/11/2026, item B2): fixed UTILITY templates approved
 * by Meta, one per moment, each with two URL buttons — "Acompanhar entrega"
 * and "Parar de receber". The carrier's own text goes only by e-mail now:
 * the free text inside a single parameter is what Meta filed as Marketing.
 *
 * The buttons' fixed part (the web origin and the path) is approved at Meta
 * with the template, so each environment's WABA has its own host; the only
 * variable is the end of the URL — the 64-hex tracking token. "Parar de
 * receber" opens the web's short route /parar/<token> (item B5), because a
 * Meta URL button takes one variable, at the end.
 */

const CUSTOMER_VARIABLES = {
  recipient: {
    meaning: "Nome do destinatário",
    label: "destinatário",
    max: 60,
    fallback: "cliente",
    sample: "Mercado Bom Preço",
  },
  carrier: {
    meaning: "Nome da transportadora (fantasia, senão razão social)",
    label: "transportadora",
    max: 60,
    fallback: "responsável pela sua entrega",
    sample: "Transportes Serra Azul",
  },
  reference: {
    meaning:
      'Referência da carga: "NF-e 123, 124 e mais 2", senão "pedido X", senão "sem número informado"',
    label: "notas fiscais ou pedido",
    max: 60,
    fallback: "sem número informado",
    sample: "NF-e 4521 e 4522",
  },
  deliveredAt: {
    meaning: "Data e hora da entrega no fuso da transportadora",
    label: "data e hora da entrega",
    max: 30,
    fallback: "data não informada",
    sample: "17/09/2026, 14:30",
  },
} as const satisfies Record<string, WhatsAppTemplateVariable>;

const CUSTOMER_BUTTONS = [
  {
    text: "Acompanhar entrega",
    path: "acompanhar/{{1}}",
    sample: "0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a",
  },
  {
    text: "Parar de receber",
    path: "parar/{{1}}",
    sample: "0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a",
  },
] as const;

const CUSTOMER_WHATSAPP_TEMPLATES = {
  DISPATCHED: {
    name: "trajetto_cliente_saiu_para_entrega",
    audience: "customer",
    serves: "delivery.dispatched (a rota saiu com a entrega)",
    body: "Olá, {{1}}. A transportadora {{2}} informa que a sua entrega ({{3}}) saiu hoje para o endereço de destino.\n\nAcompanhe pelo botão abaixo.",
    variables: [
      CUSTOMER_VARIABLES.recipient,
      CUSTOMER_VARIABLES.carrier,
      CUSTOMER_VARIABLES.reference,
    ],
    buttons: CUSTOMER_BUTTONS,
    validity: "12 horas",
  },
  ON_THE_WAY: {
    name: "trajetto_cliente_a_caminho",
    audience: "customer",
    serves: "delivery.on_the_way (o motorista está indo para o endereço)",
    body: "Olá, {{1}}. O motorista da transportadora {{2}} está a caminho do seu endereço com a entrega ({{3}}).\n\nAcompanhe pelo botão abaixo.",
    variables: [
      CUSTOMER_VARIABLES.recipient,
      CUSTOMER_VARIABLES.carrier,
      CUSTOMER_VARIABLES.reference,
    ],
    buttons: CUSTOMER_BUTTONS,
    validity: "1 hora",
  },
  DELIVERED: {
    name: "trajetto_cliente_entregue",
    audience: "customer",
    serves: "delivery.delivered (comprovante ou painel)",
    body: "Olá, {{1}}. A transportadora {{2}} confirma que a entrega ({{3}}) foi concluída em {{4}}.\n\nO comprovante está disponível pelo botão abaixo.",
    variables: [
      CUSTOMER_VARIABLES.recipient,
      CUSTOMER_VARIABLES.carrier,
      CUSTOMER_VARIABLES.reference,
      CUSTOMER_VARIABLES.deliveredAt,
    ],
    buttons: CUSTOMER_BUTTONS,
    validity: "12 horas",
  },
  FAILED: {
    name: "trajetto_cliente_insucesso",
    audience: "customer",
    serves: "delivery.failed (ocorrência que impede a entrega, ou painel)",
    body: "Olá, {{1}}. A transportadora {{2}} não conseguiu concluir a entrega ({{3}}) hoje.\n\nVeja os detalhes pelo botão abaixo.",
    variables: [
      CUSTOMER_VARIABLES.recipient,
      CUSTOMER_VARIABLES.carrier,
      CUSTOMER_VARIABLES.reference,
    ],
    buttons: CUSTOMER_BUTTONS,
    validity: "12 horas",
  },
} as const satisfies Record<DeliveryMessageTopic, WhatsAppTemplateDefinition>;

/** Up to this many numbers are listed; the rest become "e mais N". */
const REFERENCE_LISTED = 2;

/** "123", "123 e 124", "123, 124 e 125", "123, 124 e mais 2". */
function listOf(values: string[]): string {
  if (values.length <= REFERENCE_LISTED + 1) {
    return values.length <= 1
      ? (values[0] ?? "")
      : `${values.slice(0, -1).join(", ")} e ${values[values.length - 1]}`;
  }

  const shown = values.slice(0, REFERENCE_LISTED).join(", ");

  return `${shown} e mais ${values.length - REFERENCE_LISTED}`;
}

/**
 * What the message calls the load: the invoices (NF-e) when any has one,
 * else the order codes, else nothing — the template's fallback says "sem
 * número informado". One message per stop (B6) lists every NF-e of the stop.
 */
function deliveryReference(
  deliveries: ReadonlyArray<{
    invoiceNumber?: string | null;
    code?: string | null;
  }>,
): string | null {
  const unique = (values: Array<string | null | undefined>) => [
    ...new Set(
      values
        .map((value) => value?.replace(/\s+/g, " ").trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const invoices = unique(deliveries.map((item) => item.invoiceNumber));

  if (invoices.length > 0) return `NF-e ${listOf(invoices)}`;

  const codes = unique(deliveries.map((item) => item.code));

  if (codes.length === 0) return null;

  return codes.length === 1 ? `pedido ${codes[0]}` : `pedidos ${listOf(codes)}`;
}

interface CustomerWhatsAppInput {
  recipientName: string | null;
  carrierName: string | null;
  reference: string | null;
  /** Already formatted in the carrier's zone; DELIVERED only. */
  deliveredAt?: string | null;
  /** The ExternalRecipient's 64-hex token: the end of both button URLs. */
  accessToken: string;
}

/**
 * The moment's template, its fitted parameters and both buttons' suffixes —
 * what the provider sends — plus the body as the customer reads it, for the
 * delivery's diagnostics.
 */
function buildCustomerWhatsApp(
  topic: DeliveryMessageTopic,
  input: CustomerWhatsAppInput,
): {
  name: string;
  parameters: string[];
  urlButtonSuffixes: string[];
  preview: string;
} {
  const definition: WhatsAppTemplateDefinition =
    CUSTOMER_WHATSAPP_TEMPLATES[topic];

  const raw = [input.recipientName, input.carrierName, input.reference];

  if (topic === "DELIVERED") raw.push(input.deliveredAt ?? null);

  const parameters = fitTemplateParameters(definition, raw);

  return {
    name: definition.name,
    parameters,
    urlButtonSuffixes: (definition.buttons ?? []).map(() => input.accessToken),
    preview: fillTemplateBody(definition.body, parameters),
  };
}

/**
 * The fixed text the web shows on a WhatsApp card (B3/B4): the approved body
 * with each variable named, and the buttons' labels. Nothing in it is the
 * company's to edit.
 */
function customerWhatsAppPreview(topic: DeliveryMessageTopic): {
  template: string;
  body: string;
  buttons: string[];
} {
  const definition: WhatsAppTemplateDefinition =
    CUSTOMER_WHATSAPP_TEMPLATES[topic];

  const names = definition.variables.map(
    (variable) => `[${variable.label ?? variable.meaning}]`,
  );

  return {
    template: definition.name,
    body: fillTemplateBody(definition.body, names),
    buttons: (definition.buttons ?? []).map((button) => button.text),
  };
}

export {
  CUSTOMER_WHATSAPP_TEMPLATES,
  buildCustomerWhatsApp,
  customerWhatsAppPreview,
  deliveryReference,
};

export type { CustomerWhatsAppInput };
