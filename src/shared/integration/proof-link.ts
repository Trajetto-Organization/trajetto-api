import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import auth from "@/config/auth";
import { env } from "@/env";

/**
 * The bearer link to a delivery's receipt, sent to integrators as
 * `proof_url` (plan of 02/11/2026, L7; ADR 0009).
 *
 * The receipt PDF is produced lazily, the first time somebody asks for it,
 * so at `proof.registered` there is no document — and no verification token
 * — yet. The link therefore names the DELIVERY, signed: whoever opens it gets
 * the document produced on demand (GET /public/delivery-proof/:token), like a
 * person scanning the QR printed on it.
 *
 * Stateless and deterministic on purpose. The same delivery always gets the
 * same link, so the public read and the webhook agree and an ERP that diffs
 * payloads does not see a change on every poll; and nothing is written per
 * delivery. The HMAC covers the company as well as the id, so the capability
 * is bound to the tenant that owns the delivery. It expires with the receipt
 * (PROOF_VERIFICATION_TTL_DAYS, counted from the delivery's creation, checked
 * when the link is opened) and every link dies at once if JWT_SECRET is
 * rotated — the key is derived from it under its own label, never the
 * signing key itself.
 */
const PROOF_LINK_ROUTE = "/delivery-proof";

/** Where the route lives: public-routes is registered under /public. */
const PROOF_LINK_PATH = `/public${PROOF_LINK_ROUTE}`;

const key = Buffer.from(
  hkdfSync("sha256", auth.secret_token, "", "trajetto/proof-link", 32),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 bytes of HMAC in base64url, without padding. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

function signatureOf(deliveryId: string, businessId: string): string {
  return createHmac("sha256", key)
    .update(`${deliveryId}:${businessId}`)
    .digest("base64url");
}

function proofLinkToken(deliveryId: string, businessId: string): string {
  return `${deliveryId}.${signatureOf(deliveryId, businessId)}`;
}

/** The API's own public origin: the link is opened against the API. */
function apiOrigin(): string {
  return (env.API_HTTP_REQUEST || `http://localhost:${env.PORT}`).replace(
    /\/+$/,
    "",
  );
}

function proofLinkUrl(deliveryId: string, businessId: string): string {
  return `${apiOrigin()}${PROOF_LINK_PATH}/${proofLinkToken(deliveryId, businessId)}`;
}

/** The delivery a token names and its signature, or null when malformed. */
function readProofLinkToken(
  token: string,
): { deliveryId: string; signature: string } | null {
  const parts = token.split(".");

  if (parts.length !== 2) return null;

  const [deliveryId, signature] = parts;

  if (!UUID.test(deliveryId) || !SIGNATURE.test(signature)) return null;

  return { deliveryId, signature };
}

/** Whether `signature` was issued for this delivery of this company. */
function proofLinkSigns(
  signature: string,
  deliveryId: string,
  businessId: string,
): boolean {
  const provided = Buffer.from(signature);
  const expected = Buffer.from(signatureOf(deliveryId, businessId));

  // Length first: timingSafeEqual throws on a mismatch instead of answering.
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/** The statuses whose delivery has a receipt to show (get-proof-document). */
const PROOF_LINK_STATUSES: readonly string[] = ["DELIVERED", "FAILED"];

/**
 * The `proof_url` of a delivery in this status: the link once it ended, null
 * while it is still open (a receipt for a delivery in transit would assert
 * something that has not happened) or when it was cancelled.
 */
function proofUrlFor(delivery: {
  id: string;
  businessId?: string | null;
  status?: string | null;
}): string | null {
  if (!delivery.businessId || !delivery.status) return null;

  if (!PROOF_LINK_STATUSES.includes(delivery.status)) return null;

  return proofLinkUrl(delivery.id, delivery.businessId);
}

export {
  PROOF_LINK_PATH,
  PROOF_LINK_ROUTE,
  PROOF_LINK_STATUSES,
  proofLinkSigns,
  proofLinkToken,
  proofLinkUrl,
  proofUrlFor,
  readProofLinkToken,
};
