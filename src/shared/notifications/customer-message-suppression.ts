import { readRecipientEmails } from "@/shared/delivery/recipient-email";
import { normalizePhoneNumber } from "@/shared/providers/whatsapp-provider/phone-number";

/**
 * "Parar de receber" by phone and e-mail inside the carrier (plan of
 * 02/11/2026, B5, decision D38).
 *
 * The opt-out link used to stop only the delivery it came from: somebody who
 * receives many deliveries from the same carrier kept getting the next one's
 * messages. The click now also keeps the recipient's phone and e-mail, for
 * that carrier, under the form every later message is compared in — the same
 * number typed "(11) 99123-4567" on one NF-e and "11991234567" on the next is
 * one person. Customer messages only: internal notifications never read it.
 */

/** The two channels that reach somebody outside the company. */
type CustomerMessageChannel = "WHATSAPP" | "EMAIL";

interface SuppressionAddress {
  channel: CustomerMessageChannel;
  address: string;
}

/** The contact a customer message goes to, as the recipient row holds it. */
interface CustomerContact {
  telephone: string | null;
  email: string | null;
}

/** Trimmed and lower-cased: mailbox providers ignore the case. */
function normalizeSuppressionEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The phone as one line, however the NF-e or the spreadsheet typed it: the
 * digits the WhatsApp sender puts in `to` (E.164 without the "+",
 * normalizePhoneNumber, which already drops a dialling prefix in front — the
 * trunk "0 11 …", the international "00 55 …"), plus one correction that
 * only matters to compare:
 *
 *  - a Brazilian mobile written with 8 digits, from before the ninth digit,
 *    gets its 9. A subscriber number starting with 6-9 is a mobile
 *    (landlines start with 2-5) and every mobile now has nine digits, so
 *    "(11) 9123-4567" on an old customer record and "(11) 99123-4567" on
 *    the next NF-e are the same person.
 *
 * The sender keeps writing the line as typed (no ninth digit added); this is
 * only the key an opt-out is kept and looked up under.
 */
function normalizeSuppressionPhone(phone: string): string {
  const e164 = normalizePhoneNumber(phone);

  if (e164.length === 12 && e164.startsWith("55") && /[6-9]/.test(e164[4])) {
    return `${e164.slice(0, 4)}9${e164.slice(4)}`;
  }

  return e164;
}

/**
 * The addresses a contact is suppressed and looked up under: the phone as
 * one line (normalizeSuppressionPhone), and for the e-mail every address the
 * send writes to (readRecipientEmails), each normalized, plus the whole
 * field normalized. A field without a usable value adds nothing.
 *
 * Per address because the NF-e and the spreadsheet store a list
 * ("a@x.com.br;b@y.com.br", recipient-email.ts) and the same person comes
 * back in another one: an opt-out from "a; b" stops a delivery to "b", and
 * one to "a;c" (the e-mail goes to both, so it is not sent). The whole field
 * is the key the first release of D38 wrote and still looks up: rows written
 * before, or by a replica of it during a rollout, keep matching
 * (20261110130000 also wrote their per-address keys).
 */
function suppressionAddresses(contact: CustomerContact): SuppressionAddress[] {
  const addresses: SuppressionAddress[] = [];

  const phone = contact.telephone
    ? normalizeSuppressionPhone(contact.telephone)
    : "";

  if (phone) addresses.push({ channel: "WHATSAPP", address: phone });

  const email = contact.email ? normalizeSuppressionEmail(contact.email) : "";

  if (email) {
    addresses.push({ channel: "EMAIL", address: email });

    for (const entry of readRecipientEmails(contact.email).addresses) {
      addresses.push({
        channel: "EMAIL",
        address: normalizeSuppressionEmail(entry),
      });
    }
  }

  return uniqueSuppressionAddresses(addresses);
}

/** The same addresses once each: a contact read from two rows. */
function uniqueSuppressionAddresses(
  addresses: readonly SuppressionAddress[],
): SuppressionAddress[] {
  const seen = new Set<string>();

  return addresses.filter(({ channel, address }) => {
    const key = `${channel}:${address}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

/** Whether a contact is kept under any of these addresses. */
function sharesSuppressionAddress(
  contact: CustomerContact,
  addresses: readonly SuppressionAddress[],
): boolean {
  return suppressionAddresses(contact).some((own) =>
    addresses.some(
      (other) => other.channel === own.channel && other.address === own.address,
    ),
  );
}

/** When each channel of a delivery's contact stopped receiving (C2). */
interface MessageOptOut {
  whatsapp: Date | null;
  email: Date | null;
}

/**
 * The opt-out state the delivery's detail shows (contract C2 of 03/11/2026):
 * per channel, when the company's suppression of the contact's address was
 * written — the earliest, when the e-mail's list matches more than one —;
 * null while it receives (or has no address on that channel). A recipient
 * row opted out before the suppressions existed still stops its own
 * delivery's messages (the send checks opted_out_at too), so its date
 * answers for a channel with no suppression row.
 */
function messageOptOutOf(
  contact: CustomerContact,
  suppressions: ReadonlyArray<{
    channel: CustomerMessageChannel;
    address: string;
    created_at: Date;
  }>,
  recipientOptedOutAt: Date | null,
): MessageOptOut {
  const addresses = suppressionAddresses(contact);

  const since = (channel: CustomerMessageChannel): Date | null => {
    const own = addresses.filter((entry) => entry.channel === channel);

    if (own.length === 0) return null;

    const times = suppressions
      .filter(
        (row) =>
          row.channel === channel &&
          own.some((entry) => entry.address === row.address),
      )
      .map((row) => new Date(row.created_at).getTime());

    return times.length > 0
      ? new Date(Math.min(...times))
      : (recipientOptedOutAt ?? null);
  };

  return { whatsapp: since("WHATSAPP"), email: since("EMAIL") };
}

/** The state as the API sends it: ISO dates, null while receiving. */
interface SerializedMessageOptOut {
  whatsapp: string | null;
  email: string | null;
}

/** Null (the delivery is not the company's) reads as receiving. */
function serializeMessageOptOut(
  state: MessageOptOut | null,
): SerializedMessageOptOut {
  return {
    whatsapp: state?.whatsapp ? new Date(state.whatsapp).toISOString() : null,
    email: state?.email ? new Date(state.email).toISOString() : null,
  };
}

/**
 * Why a customer message is not sent once its address was suppressed: the
 * reason the delivery row keeps (lastError), like every other skip.
 */
const SUPPRESSED_ADDRESS_REASON =
  "Destinatário descadastrado: pediu à transportadora para não receber mais mensagens neste endereço (opt-out por telefone/e-mail, D38)";

export {
  SUPPRESSED_ADDRESS_REASON,
  messageOptOutOf,
  normalizeSuppressionEmail,
  normalizeSuppressionPhone,
  serializeMessageOptOut,
  sharesSuppressionAddress,
  suppressionAddresses,
  uniqueSuppressionAddresses,
};
export type {
  CustomerContact,
  CustomerMessageChannel,
  MessageOptOut,
  SerializedMessageOptOut,
  SuppressionAddress,
};
