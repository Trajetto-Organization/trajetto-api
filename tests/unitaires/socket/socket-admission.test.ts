import { describe, expect, it } from "vitest";

import {
  CAPACITY_RETRY_BASE_MS,
  CAPACITY_RETRY_JITTER_MS,
  HANDSHAKE_REFUSALS,
  capacityRetryAfterMs,
  createHandshakeMetrics,
  createSocketAdmission,
  engineOverCapacity,
  handshakeRefusalOf,
  keepsAddressCharge,
} from "@/shared/socket/admission";

/**
 * The socket admission's rules (plano-escala U-01, F2.19), pure.
 *
 * A deploy moves a replica's whole fleet to the replicas left over within
 * seconds, and each handshake is three Postgres round trips. Two ceilings
 * bound it, checked before the credential is read, and their refusal must
 * never be charged to the address: a mobile carrier's CGNAT puts hundreds
 * of drivers behind one, and counted as failures they locked each other out
 * of realtime for the rest of the minute. Only the capacity refusals are
 * given back: a user over their own budget is still charged, or one token
 * would loop handshakes from one address with no bound. The wiring into the
 * real Socket.IO server is socket-capacity-admission.test.ts.
 */
function error(code?: string): Error {
  const failure = new Error("recusado") as Error & { data?: { code: string } };

  if (code) failure.data = { code };

  return failure;
}

describe("the wait a capacity refusal asks for", () => {
  it("is 5 s plus up to 5 s of jitter", () => {
    expect(capacityRetryAfterMs(() => 0)).toBe(CAPACITY_RETRY_BASE_MS);
    expect(capacityRetryAfterMs(() => 0.5)).toBe(7_500);

    // Never the full 10 s, whatever the draw.
    expect(capacityRetryAfterMs(() => 1)).toBeLessThan(
      CAPACITY_RETRY_BASE_MS + CAPACITY_RETRY_JITTER_MS,
    );
    expect(capacityRetryAfterMs(() => -3)).toBe(CAPACITY_RETRY_BASE_MS);
  });

  it("spreads the refused instead of bringing them back together", () => {
    const waits = new Set(
      Array.from({ length: 50 }, () => capacityRetryAfterMs()),
    );

    expect(waits.size).toBeGreaterThan(10);
  });
});

describe("the in-flight ceiling", () => {
  it("refuses the handshake past it, and admits again once one is done", () => {
    const admission = createSocketAdmission({
      limits: () => ({ maxInflight: 2, maxConnections: 0 }),
      connections: () => 0,
      random: () => 0,
    });

    const first = admission.enter();
    const second = admission.enter();
    const third = admission.enter();

    expect(first.admitted && second.admitted).toBe(true);
    expect(third).toEqual({
      admitted: false,
      reason: "inflight",
      retryAfterMs: CAPACITY_RETRY_BASE_MS,
    });
    expect(admission.inflight()).toBe(2);

    if (first.admitted) first.release();

    expect(admission.enter().admitted).toBe(true);
  });

  it("is released once, whatever path ends the handshake", () => {
    const admission = createSocketAdmission({
      limits: () => ({ maxInflight: 1, maxConnections: 0 }),
      connections: () => 0,
    });

    const pass = admission.enter();

    if (!pass.admitted) throw new Error("admitida");

    pass.release();
    pass.release();

    // A double release would let two in where the ceiling says one.
    expect(admission.inflight()).toBe(0);
    expect(admission.enter().admitted).toBe(true);
    expect(admission.enter().admitted).toBe(false);
  });

  it("is off at 0", () => {
    const admission = createSocketAdmission({
      limits: () => ({ maxInflight: 0, maxConnections: 0 }),
      connections: () => 0,
    });

    for (let index = 0; index < 500; index += 1) {
      expect(admission.enter().admitted).toBe(true);
    }
  });
});

describe("the socket ceiling", () => {
  it("refuses once the connections, this one included, pass it", () => {
    let connections = 3;
    const admission = createSocketAdmission({
      limits: () => ({ maxInflight: 64, maxConnections: 3 }),
      connections: () => connections,
      random: () => 0.999,
    });

    // The third socket of three: room for it.
    expect(admission.enter().admitted).toBe(true);

    connections = 4;

    const refused = admission.enter();

    expect(refused.admitted).toBe(false);
    expect(!refused.admitted && refused.reason).toBe("connections");
    expect(!refused.admitted && refused.retryAfterMs).toBeGreaterThan(9_900);
  });

  it("reads the limits at every handshake", () => {
    let maxConnections = 1;
    const admission = createSocketAdmission({
      limits: () => ({ maxInflight: 0, maxConnections }),
      connections: () => 2,
    });

    expect(admission.enter().admitted).toBe(false);

    maxConnections = 0;

    expect(admission.enter().admitted).toBe(true);
  });
});

describe("the engine's backstop", () => {
  it("refuses an upgrade only past the ceiling by the in-flight headroom", () => {
    const limits = { maxInflight: 64, maxConnections: 5_000 };

    // Below that the middleware refuses with the wait the clients honour.
    expect(engineOverCapacity(5_001, limits)).toBe(false);
    expect(engineOverCapacity(5_063, limits)).toBe(false);
    expect(engineOverCapacity(5_064, limits)).toBe(true);
  });

  it("keeps a headroom when the semaphore is off, and nothing with no ceiling", () => {
    expect(
      engineOverCapacity(5_010, { maxInflight: 0, maxConnections: 5_000 }),
    ).toBe(false);
    expect(
      engineOverCapacity(5_064, { maxInflight: 0, maxConnections: 5_000 }),
    ).toBe(true);
    expect(
      engineOverCapacity(1_000_000, { maxInflight: 64, maxConnections: 0 }),
    ).toBe(false);
  });
});

describe("what the address keeps", () => {
  it("gives the attempt back when the socket was admitted", () => {
    expect(keepsAddressCharge(null)).toBe(false);
    expect(keepsAddressCharge(undefined)).toBe(false);
  });

  it("gives it back for a full replica or a database blink", () => {
    // The drivers behind the same CGNAT did nothing wrong.
    expect(keepsAddressCharge(error("SOCKET_UNAVAILABLE"))).toBe(false);
  });

  it("keeps it once the user's own budget or sockets refused", () => {
    // Given back, one valid token looped handshakes from one address with
    // no bound at all once its 30 a minute ran out: every attempt still a
    // websocket upgrade, a signature check and two Redis round trips, and
    // the 300 a minute that cut the address off before U-01 never reached.
    for (const code of ["SOCKET_RATE_LIMITED", "SOCKET_TOO_MANY_CONNECTIONS"]) {
      expect(keepsAddressCharge(error(code)), code).toBe(true);
    }
  });

  it("keeps it for a credential failure, a refusal with no code and an unknown code", () => {
    for (const failure of [
      error("AUTH_TOKEN_INVALID"),
      error("SOCKET_TICKET_INVALID"),
      error("AUTH_SESSION_INVALIDATED"),
      error(),
      error("SOMETHING_NEW"),
    ]) {
      expect(keepsAddressCharge(failure)).toBe(true);
    }
  });
});

describe("the refusal a middleware error stands for", () => {
  it("names the reason by the code", () => {
    expect(handshakeRefusalOf(error("SOCKET_RATE_LIMITED"))).toBe(
      "rate_limited",
    );
    expect(handshakeRefusalOf(error("SOCKET_TOO_MANY_CONNECTIONS"))).toBe(
      "too_many_connections",
    );
    expect(handshakeRefusalOf(error("SOCKET_UNAVAILABLE"))).toBe("unavailable");
    expect(handshakeRefusalOf(error("AUTH_TOKEN_INVALID"))).toBe("credential");
    expect(handshakeRefusalOf(error())).toBe("credential");
  });
});

describe("the handshake metrics", () => {
  it("reads p50 and p99 from the buckets, and counts the refusals by reason", () => {
    let clock = 0;
    const metrics = createHandshakeMetrics({ now: () => clock });

    for (let index = 0; index < 98; index += 1) metrics.record(8, null);

    metrics.record(400, "credential");
    metrics.record(7_000, "unavailable");
    metrics.refuse("inflight");

    clock = 30_000;

    const window = metrics.snapshot();

    expect(window).toMatchObject({
      window_seconds: 30,
      handshakes: 100,
      admitted: 98,
      p50_ms: 10,
      p99_ms: 500,
      max_ms: 7_000,
    });
    expect(window.refused).toMatchObject({
      credential: 1,
      unavailable: 1,
      inflight: 1,
      connections: 0,
    });

    // Every reason present, so a reader never handles a missing key.
    expect(Object.keys(window.refused).sort()).toEqual(
      [...HANDSHAKE_REFUSALS].sort(),
    );
  });

  it("answers above the last bucket with the largest seen", () => {
    const metrics = createHandshakeMetrics();

    metrics.record(12_345.67, null);

    expect(metrics.snapshot()).toMatchObject({
      p50_ms: 12_345.7,
      p99_ms: 12_345.7,
    });
  });

  it("starts a fresh window at each rotation", () => {
    let clock = 0;
    const metrics = createHandshakeMetrics({ now: () => clock });

    metrics.record(3, null);
    metrics.refuse("connections");

    clock = 60_000;

    expect(metrics.rotate()).toMatchObject({ handshakes: 1, p50_ms: 5 });

    expect(metrics.snapshot()).toMatchObject({
      window_seconds: 0,
      handshakes: 0,
      admitted: 0,
      p50_ms: null,
      p99_ms: null,
      max_ms: null,
    });
    expect(metrics.snapshot().refused.connections).toBe(0);
  });
});
