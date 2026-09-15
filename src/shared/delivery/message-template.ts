import Handlebars from "handlebars";

/**
 * What a company says to the person waiting for a delivery.
 *
 * The voice is theirs. A carrier that addresses "prezado cliente" and one that
 * writes under the shipper's brand are both right, and a single hard-coded
 * sentence would make Trajetto speak over them to their own customers.
 *
 * Rendered with the same Handlebars the transactional mails already use, over
 * a CLOSED variable set. Closed on purpose: the templates are edited in a
 * form by a dispatcher, and a template language with access to the whole
 * payload would let a typo print an internal id — or let somebody curious
 * print the driver's phone into a message that goes to a customer.
 */
interface DeliveryMessageVariables {
  /** The person the carrier is writing to. */
  destinatario: string;

  /** The carrier's own name, as they want to be called. */
  transportadora: string;

  /** The load, by whichever reference the company uses. */
  nota: string;
  pedido: string;

  cidade: string;
  uf: string;

  /** Already formatted for a reader, never an ISO string. */
  previsao: string;
  data_entrega: string;

  recebido_por: string;

  /** The tracking page. Always present — it is the point of the message. */
  link: string;

  /** One click to stop. Required in every channel that allows a link. */
  link_descadastro: string;
}

/** Every name a template may use, for the editor to show and validate. */
const TEMPLATE_VARIABLES: Array<keyof DeliveryMessageVariables> = [
  "destinatario",
  "transportadora",
  "nota",
  "pedido",
  "cidade",
  "uf",
  "previsao",
  "data_entrega",
  "recebido_por",
  "link",
  "link_descadastro",
];

/**
 * Compiled with escaping OFF, and that is a deliberate, bounded decision.
 *
 * These messages are plain text — WhatsApp and the body of an e-mail — and
 * HTML-escaping them turns every "Café & Cia" into "Café &amp; Cia" in a
 * customer's message. The values are never interpolated into markup: the mail
 * template puts the rendered body into a text node, and WhatsApp has no markup
 * at all. If a channel that renders HTML is ever added, it escapes at ITS
 * boundary, which is where escaping belongs.
 */
function renderDeliveryMessage(
  template: string,
  variables: DeliveryMessageVariables,
): string {
  const compiled = Handlebars.compile(template, { noEscape: true });

  return compiled(variables).trim();
}

/**
 * Whether a template only uses names we publish.
 *
 * Checked when the company SAVES it, not when it sends: a dispatcher who typed
 * `{{motorista}}` must find out in the form, not by a customer receiving a
 * message with a blank in it.
 */
function unknownTemplateVariables(template: string): string[] {
  const used = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
    (match) => match[1],
  );

  const known = new Set<string>(TEMPLATE_VARIABLES as string[]);

  return [...new Set(used.filter((name) => !known.has(name)))];
}

export {
  TEMPLATE_VARIABLES,
  renderDeliveryMessage,
  unknownTemplateVariables,
};
export type { DeliveryMessageVariables };
