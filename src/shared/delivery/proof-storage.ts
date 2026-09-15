import { randomBytes } from "node:crypto";

/**
 * Where a delivery's receipt lives, and the string that lets a stranger see it.
 *
 * The KEY is derived from the delivery and not random. Two people opening a
 * receipt for the first time at the same moment both render it, and a random
 * key would leave one object in the bucket that no row points at, forever. The
 * same key means the second write simply overwrites identical content.
 *
 * The TOKEN is the opposite: 32 bytes of randomness, because it is the only
 * thing standing between a printed QR code and somebody else's delivery. An id
 * would be guessable by counting, and a uuid v7 leaks the moment it was made.
 */
function proofStorageKey(deliveryId: string): string {
  return `deliveryProofs/${deliveryId}/comprovante.pdf`;
}

function newVerificationToken(): string {
  return randomBytes(32).toString("hex");
}

/** The filename the browser saves it under. */
function proofFilename(delivery: {
  invoice_number?: string | null;
  code?: string | null;
  id: string;
}): string {
  const reference =
    delivery.invoice_number?.trim() ||
    delivery.code?.trim() ||
    delivery.id.slice(0, 8);

  const safe = reference.replace(/[^a-zA-Z0-9._-]/g, "-");

  return `comprovante-${safe}.pdf`;
}

export { newVerificationToken, proofFilename, proofStorageKey };
