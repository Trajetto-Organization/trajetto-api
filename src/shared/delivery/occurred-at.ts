import { z } from "zod";

/**
 * When a driver's action happened, apart from when it reached us.
 *
 * The app queues arrivals, proofs, occurrences and departures while offline
 * and sends them when the signal comes back — possibly hours later. Stamping
 * them with the server's clock at receipt told the customer "entregue às
 * 13:40" for a receipt signed at 10:05, closed the stop three hours late and
 * charged the SLA for it (MOB-08).
 *
 * The body carries the instant of the tap (`occurred_at`) and the request the
 * instant it was sent (`X-Client-Sent-At`), both read from the phone's clock.
 * Only their DIFFERENCE is used, anchored on the server's clock, so a phone
 * set to the wrong time or the wrong zone costs nothing: a tap three hours
 * before the send is three hours before now, whatever the phone believes now
 * is.
 *
 * Advisory by design. What cannot be read is ignored rather than refused — a
 * refusal would park a real proof on the driver's pending screen over a
 * timestamp — and the server's clock is used instead, which is what every
 * build before this one gets anyway.
 */

/** The header the app stamps at the moment it sends. */
const CLIENT_SENT_AT_HEADER = "x-client-sent-at";

/**
 * How far back a fact may be dated.
 *
 * The app's offline horizon (its cache lives a week). An instant older than
 * that, after the clock correction, is not a driver who was out of signal —
 * it is a body nobody should trust, and the receipt time is used instead.
 */
const OCCURRED_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ISO 8601 with a time part. `Date.parse` alone would read "0" as the year
// 2000 and a bare date as midnight UTC — neither is an instant a phone sent.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function parseInstant(value: unknown): number | null {
  // A repeated header arrives as an array; the first is the one the client
  // meant, and anything else is not worth a refusal.
  const raw = Array.isArray(value) ? value[0] : value;

  if (typeof raw !== "string" || raw.length > 64 || !ISO_INSTANT.test(raw)) {
    return null;
  }

  const ms = Date.parse(raw);

  return Number.isFinite(ms) ? ms : null;
}

interface ResolveOccurredAtInput {
  /** The body's `occurred_at`: the tap, by the phone's clock. */
  occurredAt?: unknown;

  /** The `X-Client-Sent-At` header: the send, by the same clock. */
  clientSentAt?: unknown;

  now?: Date;
}

/**
 * The server-clock instant of the fact, or null for "use the receipt time".
 *
 * - No readable `occurred_at`: null.
 * - A readable send instant: the tap is moved by the phone's clock error
 *   (server now − phone send). Without one, the phone's clock is trusted.
 * - Never after now: a corrected instant in the future is clamped to now.
 * - Never older than OCCURRED_AT_MAX_AGE_MS: null.
 */
function resolveOccurredAt({
  occurredAt,
  clientSentAt,
  now = new Date(),
}: ResolveOccurredAtInput): Date | null {
  const corrected = correctedTap(occurredAt, clientSentAt, now);

  if (corrected === null) return null;

  if (corrected > now.getTime()) return new Date(now.getTime());

  if (corrected < now.getTime() - OCCURRED_AT_MAX_AGE_MS) return null;

  return new Date(corrected);
}

/** The tap on the server's clock, in ms, or null when there is none to read. */
function correctedTap(
  occurredAt: unknown,
  clientSentAt: unknown,
  now: Date,
): number | null {
  const tapped = parseInstant(occurredAt);

  if (tapped === null) return null;

  const sent = parseInstant(clientSentAt);
  const clockError = sent === null ? 0 : now.getTime() - sent;

  return tapped + clockError;
}

/**
 * Whether the request carries a readable tap OLDER than the offline horizon.
 *
 * resolveOccurredAt answers null for such a tap, as it does for none at all:
 * past the horizon it is not trusted as the time of a fact. But a COMMAND
 * replayed that late is not a command sent now, and the one caller that acts
 * on the state of the present — the legacy departure, which moves whatever
 * is loose when it runs — must tell the two apart. No tap, or an unreadable
 * one, is never stale: every build before MOB-08 keeps today's behaviour.
 */
function isOccurredAtStale({
  occurredAt,
  clientSentAt,
  now = new Date(),
}: ResolveOccurredAtInput): boolean {
  const corrected = correctedTap(occurredAt, clientSentAt, now);

  return (
    corrected !== null && corrected < now.getTime() - OCCURRED_AT_MAX_AGE_MS
  );
}

/**
 * The body field, shared by every driver action that can be queued.
 *
 * A lenient string on purpose (see the module docblock): an unreadable value
 * is ignored by resolveOccurredAt, never turned into a 400 that the app's
 * outbox would mark as a permanent failure.
 */
const occurredAtField = z
  .string()
  .max(64)
  .optional()
  .describe(
    "Quando o motorista registrou o fato no aparelho (ISO 8601), para envios feitos depois, sem sinal. Opcional: ausente ou ilegível, vale a hora do recebimento. Corrigido pelo relógio do aparelho via header X-Client-Sent-At; nunca no futuro nem mais de 7 dias no passado.",
  );

/**
 * The header, as the document states it, for every route whose controller
 * reads it.
 *
 * Declared through `config.openapi.headers`, never as `schema.headers`: a
 * headers schema would be VALIDATED, and Fastify would replace
 * `request.headers` with the parsed object — a zod object drops every header
 * it does not name. Documentation only, like Idempotency-Key (see
 * idempotency-documentation.ts). Lenient for the same reason as the body
 * field: an unreadable stamp is ignored, never refused.
 */
const clientSentAtHeaders = z.object({
  [CLIENT_SENT_AT_HEADER]: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Quando o aparelho enviou esta requisição (ISO 8601), pelo relógio do aparelho, carimbado a cada tentativa. Só a diferença entre ele e o `occurred_at` do corpo é usada, ancorada no relógio do servidor, então um aparelho com a hora errada ainda registra a hora certa do fato. Opcional: sem ele, o `occurred_at` é lido como está; ilegível, é ignorado.",
    ),
});

export {
  CLIENT_SENT_AT_HEADER,
  OCCURRED_AT_MAX_AGE_MS,
  clientSentAtHeaders,
  isOccurredAtStale,
  occurredAtField,
  resolveOccurredAt,
};
export type { ResolveOccurredAtInput };
