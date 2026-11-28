import { z } from "zod";

/**
 * The recipient's e-mail, whichever door the delivery came in by.
 *
 * The integration API takes one address (recipientEmailField). The NF-e
 * import and the spreadsheet took whatever the field said into a TEXT
 * column, unchecked, and the notification pipeline handed it to
 * nodemailer's address parser, inside the API process, on every customer
 * notice: a crafted list stalled it for seconds per send
 * (GHSA-2x7j-588g-ccc2), and a malformed one could be read as a mailbox at
 * another domain. An NF-e also carries more than one
 * address in that one field, separated by ";" — what ERPs write
 * ("compras@cliente.com.br;financeiro@cliente.com.br") — and a list pasted
 * from a mail client comes separated by ",", which nodemailer used to send
 * to as well.
 *
 * So the two imports read the field as a list: every entry checked with the
 * create's own rule, the valid ones kept as written (once each, at most
 * MAX_RECIPIENT_EMAILS) and stored joined by ";", the rest left out and
 * quoted on the import row. The send reads the stored value the same way,
 * so a row written before this rule reaches the transport only with its
 * valid addresses. The panel's create and edit take the same list
 * (panelRecipientEmailField) and store it the same way, so the form shows
 * back what an import stored and saves it untouched.
 */
const RECIPIENT_EMAIL_MAX_LENGTH = 100;

/** An NF-e's field holds 60 characters: two or three real addresses. */
const MAX_RECIPIENT_EMAILS = 5;

/** What the stored list is joined by: the NF-e's own separator. */
const RECIPIENT_EMAIL_SEPARATOR = ";";

/**
 * Entries looked at before the rest of the field is left unread: the work a
 * value can make the import or the send do stays bounded, however long it is.
 * Blanks between separators ("a@b.com;;") are not entries and do not count.
 */
const MAX_ENTRIES_READ = MAX_RECIPIENT_EMAILS * 4;

/** The left-out entries the import row's note quotes, and how much of each. */
const QUOTED_ENTRIES = 2;
const QUOTED_ENTRY_LENGTH = 40;

/** The longest list the panel takes: five addresses and "; ". */
const RECIPIENT_EMAIL_LIST_MAX_LENGTH =
  MAX_RECIPIENT_EMAILS * (RECIPIENT_EMAIL_MAX_LENGTH + 2);

const RECIPIENT_EMAIL_MESSAGES = {
  invalid: "O e-mail do destinatário não é válido.",
  tooLong: `O e-mail deve ter no máximo ${RECIPIENT_EMAIL_MAX_LENGTH} caracteres.`,
  tooMany: `Informe no máximo ${MAX_RECIPIENT_EMAILS} e-mails do destinatário.`,
  listTooLong: `Informe no máximo ${MAX_RECIPIENT_EMAILS} e-mails do destinatário, de até ${RECIPIENT_EMAIL_MAX_LENGTH} caracteres cada.`,
} as const;

/** One address, as the manual create and the integration API check it. */
const recipientEmailField = z
  .string()
  .email({ message: RECIPIENT_EMAIL_MESSAGES.invalid })
  .max(RECIPIENT_EMAIL_MAX_LENGTH, {
    message: RECIPIENT_EMAIL_MESSAGES.tooLong,
  });

interface RecipientEmails {
  /** The usable addresses, as written, once each, in the field's order. */
  addresses: string[];

  /** How many distinct entries were left out as not an address. */
  invalid: number;

  /**
   * The first of those (QUOTED_ENTRIES), cut to QUOTED_ENTRY_LENGTH and on
   * one line: what the import row's note quotes for the dispatcher to fix.
   */
  rejected: string[];

  /** More distinct valid addresses than are used (MAX_RECIPIENT_EMAILS). */
  overflow: boolean;

  /** More entries than are read (MAX_ENTRIES_READ): the rest went unread. */
  truncated: boolean;
}

/**
 * The field's entries, trimmed, in order, blanks skipped: at most `limit`,
 * and whether any was left unread. ";" and "," both separate — neither is
 * ever part of an address recipientEmailField accepts. Each search starts
 * where the last one stopped, so the cost is linear in the field, never in
 * entries times length.
 */
function splitRecipientEmails(
  raw: string,
  limit: number,
): { entries: string[]; truncated: boolean } {
  const entries: string[] = [];

  // Fresh per call: a /g regex carries its position between uses.
  const entryStart = /[^;,\s]/g;
  const separator = /[;,]/g;

  let start = 0;

  while (start < raw.length) {
    entryStart.lastIndex = start;

    const next = entryStart.exec(raw);

    if (!next) break;

    if (entries.length === limit) return { entries, truncated: true };

    separator.lastIndex = next.index;

    const found = separator.exec(raw);
    const end = found ? found.index : raw.length;

    entries.push(raw.slice(next.index, end).trim());
    start = end + 1;
  }

  return { entries, truncated: false };
}

/** Length first: the e-mail check never runs over an oversized entry. */
function isRecipientEmail(entry: string): boolean {
  return (
    entry.length <= RECIPIENT_EMAIL_MAX_LENGTH &&
    recipientEmailField.safeParse(entry).success
  );
}

/**
 * A left-out entry as the note shows it: on one line, at most
 * QUOTED_ENTRY_LENGTH characters (whole code points), "…" when cut. Only the
 * head is ever looked at, however long the entry.
 */
function quotedEntry(entry: string): string {
  // Forty code points fit in eighty UTF-16 units.
  const head = entry.slice(0, QUOTED_ENTRY_LENGTH * 2);

  // Line breaks, tabs and control characters read as one space.
  const points = Array.from(head.replace(/[\s\p{Cc}]+/gu, " "));

  const cut = points.length > QUOTED_ENTRY_LENGTH || entry.length > head.length;

  return cut
    ? `${points.slice(0, QUOTED_ENTRY_LENGTH).join("").trimEnd()}…`
    : points.join("");
}

/**
 * The field as a list of addresses: what can be written to, and what was
 * left out (and why).
 */
function readRecipientEmails(raw: string | null | undefined): RecipientEmails {
  const result: RecipientEmails = {
    addresses: [],
    invalid: 0,
    rejected: [],
    overflow: false,
    truncated: false,
  };

  if (!raw) return result;

  const { entries, truncated } = splitRecipientEmails(raw, MAX_ENTRIES_READ);

  result.truncated = truncated;

  // Mailbox providers ignore the case: the same address typed twice is one
  // recipient, and the same mistake twice is one note.
  const seen = new Set<string>();
  const refused = new Set<string>();

  for (const entry of entries) {
    const key = entry.toLowerCase();

    if (!isRecipientEmail(entry)) {
      if (refused.has(key)) continue;

      refused.add(key);
      result.invalid += 1;

      if (result.rejected.length < QUOTED_ENTRIES) {
        result.rejected.push(quotedEntry(entry));
      }

      continue;
    }

    if (seen.has(key)) continue;

    seen.add(key);

    if (result.addresses.length === MAX_RECIPIENT_EMAILS) {
      result.overflow = true;
      continue;
    }

    result.addresses.push(entry);
  }

  return result;
}

/** What the delivery stores: the usable addresses, or nothing. */
function storedRecipientEmail(emails: RecipientEmails): string | null {
  return emails.addresses.length > 0
    ? emails.addresses.join(RECIPIENT_EMAIL_SEPARATOR)
    : null;
}

/** `"a"`, `"a" e "b"`, `"a", "b" e outros 3`. */
function quotedList(quoted: string[], total: number): string {
  const names = quoted.map((entry) => `"${entry}"`);
  const others = total - quoted.length;

  if (others > 0) return `${names.join(", ")} e outros ${others}`;

  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`
    : names[0];
}

/**
 * The import row's note when the field lost something on the way in, or
 * null. The delivery is created all the same: a bad e-mail is a missing
 * customer notice, not a missing delivery.
 */
function recipientEmailNotice(emails: RecipientEmails): string | null {
  const notes: string[] = [];

  if (emails.invalid === 1) {
    notes.push(
      `O e-mail ${quotedList(emails.rejected, 1)} do destinatário não é válido e não será usado nos avisos ao cliente.`,
    );
  } else if (emails.invalid > 1) {
    notes.push(
      `Os e-mails ${quotedList(emails.rejected, emails.invalid)} do destinatário não são válidos e não serão usados nos avisos ao cliente.`,
    );
  }

  if (emails.overflow) {
    notes.push(
      `Só os ${MAX_RECIPIENT_EMAILS} primeiros e-mails válidos do destinatário serão usados nos avisos ao cliente.`,
    );
  }

  if (emails.truncated) {
    notes.push(
      `O campo de e-mail do destinatário tem itens demais: só os ${MAX_ENTRIES_READ} primeiros foram lidos.`,
    );
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

/**
 * Any value as the imports store it and the send reads it: the valid
 * addresses joined by ";", or null. Two values that give the same are the
 * same recipients.
 */
function canonicalRecipientEmail(
  raw: string | null | undefined,
): string | null {
  return storedRecipientEmail(readRecipientEmails(raw));
}

/**
 * The panel's create and edit: one address typed, or a list (the one an
 * import stored, or typed), each entry by recipientEmailField and at most
 * MAX_RECIPIENT_EMAILS of them. Refused whole, with the entry's own
 * sentence, when one is not an address: unlike an imported file, the person
 * can fix what is in front of them. Stored as the imports store it (joined
 * by ";", once each), so every door writes the same shape. The web mirrors
 * it (trajetto-ui src/schemas/recipient-email-field, compared by
 * recipient-email-api-parity.test.ts there).
 */
const recipientEmailListField = z
  .string()
  .superRefine((value, ctx) => {
    const refuse = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    // Measured here in UTF-16 units, not by max(): zod 4 counts code points,
    // so emoji (never in an address) passed it and skipped the entries below,
    // stored as "" or without the entry that was not an address. The entries
    // of an oversized value are not read.
    if (value.length > RECIPIENT_EMAIL_LIST_MAX_LENGTH) {
      return refuse(RECIPIENT_EMAIL_MESSAGES.listTooLong);
    }

    const { entries, truncated } = splitRecipientEmails(
      value,
      MAX_RECIPIENT_EMAILS,
    );

    if (truncated) return refuse(RECIPIENT_EMAIL_MESSAGES.tooMany);

    if (entries.length === 0) return refuse(RECIPIENT_EMAIL_MESSAGES.invalid);

    for (const entry of entries) {
      const parsed = recipientEmailField.safeParse(entry);

      if (!parsed.success) {
        return refuse(
          parsed.error.issues[0]?.message ?? RECIPIENT_EMAIL_MESSAGES.invalid,
        );
      }
    }
  })
  // Runs only on a value the checks above passed: at least one entry, every
  // one an address, so the join is never empty.
  .transform((value) =>
    readRecipientEmails(value).addresses.join(RECIPIENT_EMAIL_SEPARATOR),
  );

/**
 * The field on the panel's create and edit bodies: blank clears it, like
 * the form's other optional fields.
 */
const panelRecipientEmailField = z
  .preprocess(
    (val) => (val === "" ? null : val),
    recipientEmailListField.nullable().optional(),
  )
  .describe(
    `E-mail do destinatário: um, ou até ${MAX_RECIPIENT_EMAILS} separados por ";" ou "," (como a importação da NF-e e da planilha lê). Cada um passa pela regra do cadastro de um endereço; grava os endereços juntos por ";", sem repetição, como as importações gravam. Vazio ou nulo: sem e-mail (na edição, apaga o atual).`,
  );

export {
  MAX_ENTRIES_READ,
  MAX_RECIPIENT_EMAILS,
  RECIPIENT_EMAIL_MAX_LENGTH,
  RECIPIENT_EMAIL_MESSAGES,
  RECIPIENT_EMAIL_SEPARATOR,
  canonicalRecipientEmail,
  panelRecipientEmailField,
  readRecipientEmails,
  recipientEmailField,
  recipientEmailListField,
  recipientEmailNotice,
  storedRecipientEmail,
};
export type { RecipientEmails };
