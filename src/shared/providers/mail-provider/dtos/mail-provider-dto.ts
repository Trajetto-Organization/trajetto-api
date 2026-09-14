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

export { MailProviderProps };
