import { env } from "@/env";

import { MAX_TEMPLATE_PARAMETER_LENGTH } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";

import {
  renderDeliveryMessage,
  type DeliveryMessageVariables,
} from "./message-template";

/**
 * The most a WhatsApp body can carry: the template parameter's cap. Anything
 * longer is cut by the provider — at the END, which is exactly where the
 * opt-out link sits in every template the editor suggests.
 */
const WHATSAPP_BODY_MAX = MAX_TEMPLATE_PARAMETER_LENGTH;

/** Hex characters in a recipient's access token (32 random bytes). */
const ACCESS_TOKEN_LENGTH = 64;

/**
 * The two links a customer message carries, in one place: the tracking page
 * and the way out of the messages. Built from the public base URL.
 */
function customerLinks(accessToken: string): {
  link: string;
  link_descadastro: string;
} {
  const base = env.HTTP_REQUEST.replace(/\/+$/, "");
  const link = `${base}/acompanhar/${accessToken}`;

  return { link, link_descadastro: `${link}/parar` };
}

/** What Meta accepts in a template parameter: no newlines, no runs of spaces. */
function flattenWhatsAppText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut at the last word boundary that fits, or hard when there is none. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;

  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");

  return (lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * A customer's WhatsApp body that fits the cap AND carries the opt-out link.
 *
 * The provider flattens and cuts at the cap from the end, so a long template
 * lost its '/parar' — the one line a message to a stranger cannot go without,
 * from the number every tenant shares. Here the link is taken out, the rest is
 * cut to leave room, and the link goes back at the end, labelled. A body that
 * fits and already has it is returned as the company wrote it (flattened, as
 * the provider would). A body without it — a template stored past the save's
 * check — gets it appended: the rule holds at the boundary, not only in the
 * form.
 */
function fitWhatsAppBody(
  text: string,
  optOutLink: string,
  max: number = WHATSAPP_BODY_MAX,
): string {
  const flat = flattenWhatsAppText(text);

  if (flat.includes(optOutLink) && flat.length <= max) return flat;

  const suffix = `Para não receber mais mensagens: ${optOutLink}`;

  const rest = flattenWhatsAppText(flat.split(optOutLink).join(" "));

  if (rest.length + 1 + suffix.length <= max) {
    return rest ? `${rest} ${suffix}` : suffix;
  }

  // "… " between the cut text and the link.
  const room = max - suffix.length - 2;

  return `${cutAtWord(rest, room)}… ${suffix}`;
}

/**
 * How long a WhatsApp template comes out with the links at their real
 * length and every free-text variable empty — the least it will ever be.
 * Over the cap, the company's own text is certain to be cut on every send,
 * so the save refuses it.
 */
function minimumWhatsAppLength(template: string): number {
  const empty: DeliveryMessageVariables = {
    destinatario: "",
    transportadora: "",
    nota: "",
    pedido: "",
    cidade: "",
    uf: "",
    previsao: "",
    data_entrega: "",
    recebido_por: "",
    ...customerLinks("0".repeat(ACCESS_TOKEN_LENGTH)),
  };

  return flattenWhatsAppText(renderDeliveryMessage(template, empty)).length;
}

export {
  WHATSAPP_BODY_MAX,
  customerLinks,
  fitWhatsAppBody,
  flattenWhatsAppText,
  minimumWhatsAppLength,
};
