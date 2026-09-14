/**
 * A Message-ID that is the same every time we send the same message.
 *
 * SMTP has no idempotency key. What it has is Message-ID, and RFC 5322 makes
 * it the identity of a message rather than of a send: two transmissions
 * carrying the same one are, by the standard, the same message arriving twice.
 * Gmail and most large providers act on that and suppress the copy.
 *
 * So this is a mitigation, not a guarantee, and it is worth being exact about
 * which. The pipeline calls a provider and then marks the row delivered, and
 * nothing can make those two steps atomic across a network. When the process
 * dies in between — a deploy, an OOM, a lease lapsing under a slow send — the
 * message WILL be handed to SMTP a second time. What a deterministic
 * Message-ID buys is that the person on the other end usually does not see it
 * twice. It buys nothing at all with a receiver that does not deduplicate.
 *
 * The `reference` is the notification delivery id, which is unique per
 * (event, recipient, channel) — precisely "this message to this person", which
 * is what the identity of a message should mean.
 */
function buildMessageId(reference: string, domain: string): string {
  // The local part must survive an SMTP header: anything outside the RFC's
  // atom characters is dropped rather than escaped, since a delivery id is
  // already a UUID and has nothing to lose.
  const localPart = reference.replace(/[^A-Za-z0-9._-]/g, "");

  return `<${localPart}@${domain}>`;
}

/**
 * The domain the app sends from, used only to make the Message-ID look like
 * what it is. Falls back to the product domain when the sender is malformed;
 * a Message-ID is an identifier, and an odd-looking one is better than none.
 */
function senderDomain(fromAddress: string | undefined): string {
  const match = fromAddress?.match(/@([^\s>]+)>?\s*$/);

  return match?.[1]?.replace(/>$/, "") ?? "intrajetto.com";
}

export { buildMessageId, senderDomain };
