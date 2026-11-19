/**
 * Who gets a socket on this replica, and what a refused handshake costs the
 * address it came from (plano-escala U-01, F2.19).
 *
 * Every handshake cost three round trips to Postgres (the user, the
 * driver's eligibility, the refresh-token family; one statement since
 * plano-escala F4-05, unless SESSION_LOOKUP_MODE=legacy) and Socket.IO took
 * them all at once: a deploy that moved 1,000 sockets to the replicas left over
 * sent 1,000 handshakes into their pools in the same second, and nothing
 * bounded how many sockets one replica held. Two ceilings, checked before
 * the credential is read:
 *
 * - handshakes in flight (SOCKET_HANDSHAKE_MAX_INFLIGHT, 64): the ones in
 *   the middleware right now, waiting on Redis and Postgres;
 * - sockets held (SOCKET_MAX_CONNECTIONS, 5,000; F5-31 lowers it to what
 *   the process's file descriptors allow).
 *
 * A refusal is `SOCKET_UNAVAILABLE` with `data.retryAfterMs`, 5 s plus up to
 * 5 s of jitter, which the web and the app wait out before trying again
 * (F2-27, F2-29). It is sent from the middleware and not from the engine's
 * `allowRequest`, on purpose: an engine refusal is an HTTP 400 to the
 * upgrade, whose body no browser lets the client read, so the wait would
 * never arrive and every refused client would come back on its own backoff.
 * The engine still refuses, cheaply, once the replica is past the ceiling by
 * the in-flight headroom (`engineOverCapacity`): the upgrades that never send
 * CONNECT are file descriptors too.
 *
 * Neither refusal is charged to the address (`keepsAddressCharge`): a mobile
 * carrier's CGNAT puts hundreds of drivers behind one address, and a replica
 * at its capacity during a deploy must not lock them out of realtime for the
 * rest of the minute. The user's own limits are charged, as before.
 */

/** The wait a capacity refusal asks for, before the jitter. */
const CAPACITY_RETRY_BASE_MS = 5_000;

/** Up to this much on top, so the refused do not come back together. */
const CAPACITY_RETRY_JITTER_MS = 5_000;

/** The engine's headroom over the ceiling when the semaphore is off. */
const ENGINE_HEADROOM_WITHOUT_SEMAPHORE = 64;

function capacityRetryAfterMs(random: () => number = Math.random): number {
  const draw = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);

  return CAPACITY_RETRY_BASE_MS + Math.floor(draw * CAPACITY_RETRY_JITTER_MS);
}

interface SocketAdmissionLimits {
  /** Handshakes in the middleware at once; 0 turns the ceiling off. */
  maxInflight: number;

  /** Sockets this replica holds; 0 turns the ceiling off. */
  maxConnections: number;
}

type CapacityRefusal = "connections" | "inflight";

type AdmissionVerdict =
  | { admitted: true; release: () => void }
  | { admitted: false; reason: CapacityRefusal; retryAfterMs: number };

interface SocketAdmissionOptions {
  limits: () => SocketAdmissionLimits;

  /**
   * The engine connections this replica holds, the handshake being judged
   * included: an upgrade that never sends CONNECT holds a descriptor too.
   */
  connections: () => number;

  random?: () => number;
}

interface SocketAdmission {
  /** A pass to run the handshake, or the refusal to send. */
  enter: () => AdmissionVerdict;

  /** Handshakes holding a pass right now. */
  inflight: () => number;
}

function createSocketAdmission(
  options: SocketAdmissionOptions,
): SocketAdmission {
  const random = options.random ?? Math.random;
  let inflight = 0;

  const refuse = (reason: CapacityRefusal): AdmissionVerdict => ({
    admitted: false,
    reason,
    retryAfterMs: capacityRetryAfterMs(random),
  });

  return {
    enter() {
      const { maxInflight, maxConnections } = options.limits();

      if (maxConnections > 0 && options.connections() > maxConnections) {
        return refuse("connections");
      }

      if (maxInflight > 0 && inflight >= maxInflight) return refuse("inflight");

      inflight += 1;

      let released = false;

      return {
        admitted: true,
        // Idempotent: a handshake has one pass, whatever path ends it.
        release: () => {
          if (released) return;

          released = true;
          inflight -= 1;
        },
      };
    },
    inflight: () => inflight,
  };
}

/**
 * Whether the engine refuses an upgrade before it becomes a websocket: only
 * past the ceiling by the in-flight headroom, so a handshake that would be
 * refused politely (with the wait) still reaches the middleware.
 */
function engineOverCapacity(
  connections: number,
  limits: SocketAdmissionLimits,
): boolean {
  if (limits.maxConnections <= 0) return false;

  const headroom =
    limits.maxInflight > 0
      ? limits.maxInflight
      : ENGINE_HEADROOM_WITHOUT_SEMAPHORE;

  return connections >= limits.maxConnections + headroom;
}

/**
 * The refusals whose attempt goes back to the address: the replica was full
 * or its database blinked (`SOCKET_UNAVAILABLE`), nobody's fault.
 *
 * Not the user's own limits. `SOCKET_RATE_LIMITED` (the user's 30 a minute)
 * and `SOCKET_TOO_MANY_CONNECTIONS` (the user's sockets on this replica)
 * stay charged: given back, one valid token — its owner's, or one stolen
 * from a session not yet expired — looped handshakes from one address with
 * no bound once its own budget ran out, each still a websocket upgrade, a
 * signature check and its Redis round trips (and, past the socket ceiling,
 * the three Postgres reads), and the address never reached the 300 a minute
 * that cut it off before U-01. A client behaving normally never meets
 * either, so the drivers behind a CGNAT do not pay for it.
 */
const NOT_CHARGED_CODES = new Set(["SOCKET_UNAVAILABLE"]);

function refusalCode(error: Error | null | undefined): string | null {
  const code = (error as { data?: { code?: unknown } } | null | undefined)?.data
    ?.code;

  return typeof code === "string" ? code : null;
}

/**
 * Whether a handshake that ended with `error` keeps the attempt the address
 * was charged at the engine. Admitted: no. A refusal with no code, or with
 * any code outside the list above — a missing or bad token, a bad ticket, a
 * session that ended, a user who no longer exists, a user over their own
 * limits — yes: that is the guessing and the looping the address budget
 * exists to bound. Unknown codes are charged.
 */
function keepsAddressCharge(error: Error | null | undefined): boolean {
  if (!error) return false;

  const code = refusalCode(error);

  return !(code !== null && NOT_CHARGED_CODES.has(code));
}

/** Why a handshake was refused, as the ops_sample counts it. */
const HANDSHAKE_REFUSALS = [
  "connections",
  "inflight",
  "engine_capacity",
  "sockets_disabled",
  "address_budget",
  "rate_limited",
  "too_many_connections",
  "unavailable",
  "credential",
] as const;

type HandshakeRefusal = (typeof HANDSHAKE_REFUSALS)[number];

/** The refusal a middleware error stands for. */
function handshakeRefusalOf(error: Error): HandshakeRefusal {
  switch (refusalCode(error)) {
    case "SOCKET_RATE_LIMITED":
      return "rate_limited";
    case "SOCKET_TOO_MANY_CONNECTIONS":
      return "too_many_connections";
    case "SOCKET_UNAVAILABLE":
      return "unavailable";
    default:
      return "credential";
  }
}

/**
 * Upper bounds of the handshake duration buckets, in ms; one more counts
 * what is above the last. The p50 and p99 are read from them.
 */
const HANDSHAKE_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
] as const;

interface HandshakeWindow {
  window_seconds: number;

  /** Handshakes that ran the middleware, admitted or not. */
  handshakes: number;
  admitted: number;

  /** Upper bound of the bucket holding the quantile; null with none. */
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;

  /** Every reason, zero-filled. */
  refused: Record<HandshakeRefusal, number>;
}

interface HandshakeMetrics {
  /** One handshake through the middleware; `refusal` null when admitted. */
  record: (durationMs: number, refusal: HandshakeRefusal | null) => void;

  /** One refused before the middleware ran (the engine, the ceilings). */
  refuse: (reason: HandshakeRefusal) => void;

  snapshot: () => HandshakeWindow;

  /** The window so far, then a fresh one (the ops_sample's minute). */
  rotate: () => HandshakeWindow;
}

const emptyRefusals = (): Record<HandshakeRefusal, number> =>
  Object.fromEntries(HANDSHAKE_REFUSALS.map((reason) => [reason, 0])) as Record<
    HandshakeRefusal,
    number
  >;

function bucketOf(ms: number): number {
  const index = HANDSHAKE_LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);

  return index < 0 ? HANDSHAKE_LATENCY_BUCKETS_MS.length : index;
}

function quantile(
  counts: readonly number[],
  total: number,
  fraction: number,
  maxMs: number,
): number | null {
  if (total === 0) return null;

  const rank = Math.ceil(total * fraction);
  let seen = 0;

  for (let index = 0; index < counts.length; index += 1) {
    seen += counts[index];

    if (seen >= rank) {
      // Above the last bound, the largest seen is the honest answer.
      return index < HANDSHAKE_LATENCY_BUCKETS_MS.length
        ? HANDSHAKE_LATENCY_BUCKETS_MS[index]
        : maxMs;
    }
  }

  return maxMs;
}

function createHandshakeMetrics({
  now = Date.now,
}: { now?: () => number } = {}): HandshakeMetrics {
  let startedAt = now();
  let counts = new Array<number>(HANDSHAKE_LATENCY_BUCKETS_MS.length + 1).fill(
    0,
  );
  let handshakes = 0;
  let admitted = 0;
  let maxMs = 0;
  let refused = emptyRefusals();

  const snapshot = (): HandshakeWindow => {
    const roundedMax = Math.round(maxMs * 10) / 10;

    return {
      window_seconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
      handshakes,
      admitted,
      p50_ms: quantile(counts, handshakes, 0.5, roundedMax),
      p99_ms: quantile(counts, handshakes, 0.99, roundedMax),
      max_ms: handshakes === 0 ? null : roundedMax,
      refused: { ...refused },
    };
  };

  return {
    record(durationMs, refusal) {
      const ms = Math.max(0, durationMs);

      counts[bucketOf(ms)] += 1;
      handshakes += 1;
      maxMs = Math.max(maxMs, ms);

      if (refusal === null) admitted += 1;
      else refused[refusal] += 1;
    },
    refuse(reason) {
      refused[reason] += 1;
    },
    snapshot,
    rotate() {
      const window = snapshot();

      startedAt = now();
      counts = counts.map(() => 0);
      handshakes = 0;
      admitted = 0;
      maxMs = 0;
      refused = emptyRefusals();

      return window;
    },
  };
}

export {
  CAPACITY_RETRY_BASE_MS,
  CAPACITY_RETRY_JITTER_MS,
  HANDSHAKE_LATENCY_BUCKETS_MS,
  HANDSHAKE_REFUSALS,
  capacityRetryAfterMs,
  createHandshakeMetrics,
  createSocketAdmission,
  engineOverCapacity,
  handshakeRefusalOf,
  keepsAddressCharge,
};
export type {
  AdmissionVerdict,
  CapacityRefusal,
  HandshakeMetrics,
  HandshakeRefusal,
  HandshakeWindow,
  SocketAdmission,
  SocketAdmissionLimits,
};
