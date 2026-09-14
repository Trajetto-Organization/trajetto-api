interface MailProviderProps {
  to: string;
  subject: string;
  variables: any;
  path: string;

  /**
   * Unique id for this message. Sent as X-Entity-Ref-ID so Resend keeps
   * distinct messages apart instead of threading/deduplicating them; when
   * absent the header is omitted entirely.
   */
  referenceId?: string;
}

/**
 * What the transport said about the message it accepted.
 *
 * The id is the provider's, not ours: it is what a support conversation needs
 * in order to ask a mail provider what happened to one specific notification,
 * and the only evidence that separates "we sent it twice" from "their client
 * showed it twice".
 */
interface MailSendResult {
  messageId?: string;
}

export { MailProviderProps, MailSendResult };
