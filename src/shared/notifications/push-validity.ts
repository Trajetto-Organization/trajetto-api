/**
 * How long each kind of push is worth delivering to a phone that is off or
 * out of signal (plan of 02/11/2026, item A7; decision D41), in seconds.
 * Policies set `pushTtlSeconds` from here; a topic without one keeps the
 * provider's default (a month at FCM and APNs).
 *
 * The values are conservative: a TTL too short drops the message during a
 * long gap in signal, which on a driver's route is ordinary.
 */
const HOUR = 60 * 60;

const PUSH_TTL_SECONDS = {
  /** Released, cancelled or changed: the day's route, stale by tomorrow. */
  route: 12 * HOUR,

  /** A chat message still reads as a message the next morning. */
  chat: 24 * HOUR,

  /** The tower's answer (authorization, status override): same-day work. */
  towerDecision: 12 * HOUR,

  /** The AI's word on a receipt: the driver may still fix it the next day. */
  proofFeedback: 24 * HOUR,
} as const;

export { PUSH_TTL_SECONDS };
