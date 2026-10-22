/**
 * An e-mail address inside free text: an SMTP reply ("550 5.1.1
 * <ana@b.com>: Recipient address rejected"), a transport error, a message we
 * built ourselves. Deliberately loose — a false positive masks a harmless
 * token; a false negative writes somebody's mailbox to stdout and to the
 * database.
 */
const EMAIL_IN_TEXT =
  /[^\s<>"'(),;:@[\]]+@[^\s<>"'(),;:@[\]]+\.[^\s<>"'(),;:@[\]]+/g;

/**
 * `ana.cliente@exemplo.com.br` → `a***@exemplo.com.br`.
 *
 * The first letter and the domain are kept: enough for an operator to tell
 * "the corporate domain is refusing everything" from "one mailbox is gone",
 * not enough to write to the person.
 */
function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");

  if (at <= 0) return "***";

  return `${address.slice(0, 1)}***@${address.slice(at + 1)}`;
}

/**
 * Masks every address in a text that is about to be logged, stored or
 * returned (OBS-15). Failed deliveries are kept for 90 days and listed by
 * /health/dead-letter, and the recipient is often the carrier's customer, who
 * never agreed to have their address in our logs (LGPD: data minimisation).
 */
function redactEmails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, maskEmail);
}

export { maskEmail, redactEmails };
