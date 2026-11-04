import { env } from "@/env";

/**
 * The customer's links, for the carrier's e-mail ({{link}} and
 * {{link_descadastro}}). The WhatsApp no longer carries them in its text: it
 * goes out as a fixed template approved by Meta whose two URL buttons end in
 * the same token (plan of 02/11/2026, B2; customer-whatsapp-templates.ts).
 * The free-text fitting that used to live here — the cut that kept the
 * opt-out link inside 900 characters — went with the free text.
 */

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

export { customerLinks };
