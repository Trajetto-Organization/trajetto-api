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

interface SignedPayload {
  /** Goes in the `X-Trajetto-Signature` header. */
  header: string;

  /** Unix seconds, also carried in the header so the receiver can check it. */
  timestamp: number;

  signature: string;
}

function signWebhookPayload(
  secret: string,
  body: string,
  now: Date = new Date(),
): SignedPayload {
  const timestamp = Math.floor(now.getTime() / 1000);

  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return {
    header: `t=${timestamp},${SIGNATURE_VERSION}=${signature}`,
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
  const parts = props.header.split(",").reduce<Record<string, string>>(
    (map, entry) => {
      const [key, value] = entry.split("=");

      if (key && value) map[key.trim()] = value.trim();

      return map;
    },
    {},
  );

  const timestamp = Number(parts.t);
  const provided = parts[SIGNATURE_VERSION];

  if (!Number.isFinite(timestamp) || !provided) return false;

  const now = props.now ?? new Date();

  const tolerance =
    props.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);

  // A signature that never expires is a signature somebody replays a year
  // later.
  if (ageSeconds > tolerance) return false;

  const expected = createHmac("sha256", props.secret)
    .update(`${timestamp}.${props.body}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");

  // timingSafeEqual throws on a length mismatch, which is itself a leak if it
  // is allowed to surface as a different error.
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, providedBuffer);
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
  newWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
};
export type { SignedPayload };
