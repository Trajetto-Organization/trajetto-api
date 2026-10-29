import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How a receiver proves a call came from us.
 *
 * HMAC-SHA256 over `timestamp.body`, not over the body alone, and that detail
 * is the whole security of the scheme: a signature over the body is replayable
 * forever by anybody who once saw one valid call, and "we sent it" stops
 * meaning "we sent it now".
 *
 * The header format is deliberately the one every integrator has already
 * implemented for Stripe and GitHub — `t=…,v1=…` — because the alternative is
 * a customer writing bespoke verification code against a format they have to
 * read our documentation to learn.
 */
const SIGNATURE_VERSION = "v1";

/** Older than this and a replayed call is refused by a correct receiver. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * How long the secret a rotation replaced keeps signing beside the new one.
 * A day: long enough for somebody to deploy the new secret on the receiving
 * side during business hours, short enough that a leaked secret stops being
 * accepted by the next morning.
 */
const WEBHOOK_SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

interface SignedPayload {
  /** Goes in the `X-Trajetto-Signature` header. */
  header: string;

  /** Unix seconds, also carried in the header so the receiver can check it. */
  timestamp: number;

  signature: string;
}

/**
 * `extraSecrets` is a rotation's grace period: the secret being replaced
 * signs too, as a second `v1` after the new one (Stripe's convention), so a
 * receiver still holding the old secret keeps verifying until it switches.
 * `signature` is always the one made with `secret`.
 */
function signWebhookPayload(
  secret: string,
  body: string,
  now: Date = new Date(),
  extraSecrets: string[] = [],
): SignedPayload {
  const timestamp = Math.floor(now.getTime() / 1000);

  const sign = (key: string) =>
    createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

  const signature = sign(secret);

  const values = [signature, ...extraSecrets.map(sign)]
    .map((value) => `${SIGNATURE_VERSION}=${value}`)
    .join(",");

  return {
    header: `t=${timestamp},${values}`,
    timestamp,
    signature,
  };
}

/**
 * The verification a RECEIVER performs, written here so our own documentation
 * can point at code that is executed rather than at a snippet nobody ran.
 *
 * Constant-time on purpose. A `===` over a hex digest leaks, byte by byte,
 * how much of a guess was right — which over enough attempts is how somebody
 * forges one.
 */
function verifyWebhookSignature(props: {
  secret: string;
  body: string;
  header: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  // Every `v1`, not the last one: during a rotation the header carries one
  // per secret, and the one this receiver holds may be either.
  let timestamp = Number.NaN;
  const candidates: string[] = [];

  for (const entry of props.header.split(",")) {
    const [key, value] = entry.split("=");

    if (!key || !value) continue;

    if (key.trim() === "t") timestamp = Number(value.trim());
    if (key.trim() === SIGNATURE_VERSION) candidates.push(value.trim());
  }

  if (!Number.isFinite(timestamp) || candidates.length === 0) return false;

  const now = props.now ?? new Date();

  const tolerance = props.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);

  // A signature that never expires is a signature somebody replays a year
  // later.
  if (ageSeconds > tolerance) return false;

  const expected = createHmac("sha256", props.secret)
    .update(`${timestamp}.${props.body}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");

  // Every candidate is compared, match or not, so how many there are and
  // which one matched does not show in the timing either.
  let matched = false;

  for (const provided of candidates) {
    const providedBuffer = Buffer.from(provided, "hex");

    // timingSafeEqual throws on a length mismatch, which is itself a leak if
    // it is allowed to surface as a different error.
    if (expectedBuffer.length !== providedBuffer.length) continue;

    if (timingSafeEqual(expectedBuffer, providedBuffer)) matched = true;
  }

  return matched;
}

/**
 * A new endpoint's secret.
 *
 * Shown once, at creation, and never again — like the API key. A secret a
 * dashboard can re-display is a secret in every screenshot and every support
 * ticket.
 */
function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export {
  SIGNATURE_TOLERANCE_SECONDS,
  SIGNATURE_VERSION,
  WEBHOOK_SECRET_ROTATION_GRACE_MS,
  newWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
};
export type { SignedPayload };
