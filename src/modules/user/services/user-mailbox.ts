import { AppError } from "@/shared/errors/AppError";

/**
 * A user's e-mail is optional for one kind of account only: a driver's login
 * (decision D02 of the plan of 02/11/2026), which signs in by QR code or by
 * CPF and password and may have no mailbox at all. Office users and MASTERs
 * always have one — their request schemas require it. User.email was
 * loosened in migration 20261102120100 (nullable-expand): this release reads
 * it as optional and never writes NULL; the driver without an e-mail is
 * switched on in the next release, and every flow that mails a user has to
 * be ready for it by then.
 *
 * Two answers, depending on what the mail is:
 *  - a fan-out (notices, digests): the user without an e-mail is skipped, not
 *    an error — `withMailbox`;
 *  - a mail the flow cannot go on without (a deletion code, a 2FA code, a
 *    password link): a clear refusal instead of a message sent to nobody —
 *    `requireMailbox`. Only staff reach those flows, so the refusal guards an
 *    invariant rather than a path a person can take.
 */

type Mailable = { email: string | null };

const NO_MAILBOX_MESSAGE =
  "Este usuário não tem e-mail cadastrado. Cadastre um e-mail para usar esta função.";

function hasMailbox<T extends Mailable>(
  user: T,
): user is T & { email: string } {
  return typeof user.email === "string" && user.email.length > 0;
}

/** The users that can be mailed, in their order. */
function withMailbox<T extends Mailable>(
  users: T[],
): Array<T & { email: string }> {
  return users.filter(hasMailbox);
}

/** The address a flow must mail, or 409 USER_EMAIL_REQUIRED. */
function requireMailbox(user: Mailable): string {
  if (hasMailbox(user)) return user.email;

  throw new AppError(NO_MAILBOX_MESSAGE, 409, "USER_EMAIL_REQUIRED");
}

export { NO_MAILBOX_MESSAGE, hasMailbox, requireMailbox, withMailbox };
export type { Mailable };
