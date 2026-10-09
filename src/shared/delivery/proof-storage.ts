import { randomBytes } from "node:crypto";

/**
 * Where a delivery's receipt lives, and the string that lets a stranger see it.
 *
 * The KEY is addressed by CONTENT: the delivery, then the SHA-256 of the
 * rendered bytes (IDEMP-12). It used to be one fixed key per delivery, on the
 * belief that two renders write identical content — they do not: pdfkit
 * stamps the creation time into every file, and two first readers render with
 * two different tokens. Two renders in flight then left the bucket holding
 * one render's bytes and the row describing the other's, and the public page
 * called a genuine receipt tampered with or unknown. With the hash in the key,
 * a render never overwrites the object a row points at, and the row's
 * storage_key and sha256 — written by one upsert — always describe the same
 * bytes. A render that loses the race leaves an object no row points at; the
 * previous version of a regenerated receipt does too, and a browser may still
 * hold a signed link to it, so neither is deleted here.
 *
 * The TOKEN is the opposite: 32 bytes of randomness, because it is the only
 * thing standing between a printed QR code and somebody else's delivery. An id
 * would be guessable by counting, and a uuid v7 leaks the moment it was made.
 */
function proofStorageKey(deliveryId: string, sha256: string): string {
  return `deliveryProofs/${deliveryId}/${sha256}.pdf`;
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
