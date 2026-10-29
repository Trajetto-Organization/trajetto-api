/**
 * The budget one socket has for chat hints ("digitando", "gravando").
 *
 * A hint is relayed, never stored: the driver's goes to every SAC panel of the
 * company, the staff's to one phone. Our clients pulse them every two seconds
 * or so, but nothing on the server held anyone to that — a token in a loop
 * turned each frame into a fan-out through Redis, thousands a second.
 *
 * A token bucket per socket: a short burst (typing and recording can start
 * together, and a `recording: false` follows the last pulse), then one hint
 * per half second. Whatever exceeds it is dropped in silence — a lost hint
 * costs nothing, and an answer would only be more traffic.
 *
 * Pure, so the arithmetic is tested without a socket.
 */

/** Hints a socket may send at once. */
const HINT_BURST = 4;

/** One more hint per this many milliseconds, up to the burst. */
const HINT_REFILL_MS = 500;

interface HintBucket {
  tokens: number;
  at: number;
}

function takeHint(
  bucket: HintBucket | undefined,
  now: number,
): { allowed: boolean; bucket: HintBucket } {
  const current = bucket ?? { tokens: HINT_BURST, at: now };

  const refilled = Math.floor(Math.max(0, now - current.at) / HINT_REFILL_MS);

  const tokens = Math.min(HINT_BURST, current.tokens + refilled);

  // Advance the clock only by the intervals that were turned into tokens, so
  // a steady stream just under the rate is not rounded down into refusals.
  const at =
    tokens === HINT_BURST ? now : current.at + refilled * HINT_REFILL_MS;

  if (tokens < 1) {
    return { allowed: false, bucket: { tokens, at } };
  }

  return { allowed: true, bucket: { tokens: tokens - 1, at } };
}

export { HINT_BURST, HINT_REFILL_MS, takeHint, type HintBucket };
