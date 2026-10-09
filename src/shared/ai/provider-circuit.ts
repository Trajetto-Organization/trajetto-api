import type { ProviderFailureKind } from "./vision-provider";

/**
 * Whether the pipeline may send photos to the provider right now (AI-8).
 *
 * Open, the pipeline claims nothing: requests stay PENDING (and due, so the
 * AI lag alert sees them) instead of spending their attempts against a
 * provider that answers the same refusal to everybody. After the cooldown one
 * request goes through as a probe; its outcome closes the circuit or opens it
 * again for twice as long.
 *
 * Per replica and in memory. Every worker replica calls the same provider, so
 * each one learns the outage from its own first failure — at most one wasted
 * call per replica per cooldown — and nothing here depends on Redis or on a
 * table the schema does not have. Pure, so the state machine is unit-tested.
 */

type CircuitReason = "quota_exhausted" | "unauthorized" | "provider_down";

interface CircuitSnapshot {
  state: "closed" | "open" | "half_open";
  reason: CircuitReason | null;
  openedAt: Date | null;
  retryAt: Date | null;
}

/** Transient failures in a row, across requests, before the provider counts as down. */
const DOWN_AFTER_CONSECUTIVE_FAILURES = 5;

const COOLDOWNS: Record<CircuitReason, { firstMs: number; maxMs: number }> = {
  // A spend limit is lifted by a person: probing every few seconds would only
  // add refusals to the provider's log.
  quota_exhausted: { firstMs: 10 * 60_000, maxMs: 60 * 60_000 },
  unauthorized: { firstMs: 5 * 60_000, maxMs: 60 * 60_000 },
  provider_down: { firstMs: 60_000, maxMs: 10 * 60_000 },
};

class ProviderCircuit {
  private reason: CircuitReason | null = null;
  private openedAt: Date | null = null;
  private retryAt: Date | null = null;
  private cooldownMs = 0;
  private consecutiveFailures = 0;
  private probeInFlight = false;

  /**
   * How many requests may be claimed now: `free` when closed, one probe once
   * the cooldown is over, zero otherwise.
   */
  claimable(free: number, now: Date = new Date()): number {
    if (this.reason === null) return free;
    if (this.probeInFlight) return 0;
    if (this.retryAt && now < this.retryAt) return 0;

    return Math.min(free, 1);
  }

  /** The claim that took the probe; only one at a time. */
  markProbeStarted(): void {
    if (this.reason !== null) this.probeInFlight = true;
  }

  /** The provider answered (a valid reading or even a malformed one). */
  recordSuccess(): void {
    this.reason = null;
    this.openedAt = null;
    this.retryAt = null;
    this.cooldownMs = 0;
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  /** A probe that ended without reaching the provider (lease lost, record gone). */
  releaseProbe(): void {
    this.probeInFlight = false;
  }

  recordFailure(kind: ProviderFailureKind, now: Date = new Date()): void {
    this.probeInFlight = false;

    if (kind === "busy") {
      // The reader answered "my queue is full": it is up, and authenticated
      // us (the service checks the token first). Back-pressure never opens
      // the circuit, and closes one opened by an outage.
      this.recordSuccess();
      return;
    }

    if (kind === "permanent") {
      // The provider answered: it is up, the request is what is wrong.
      this.consecutiveFailures = 0;
      return;
    }

    if (kind === "retryable") {
      this.consecutiveFailures += 1;

      // Once open for an outage, every failed probe re-opens it.
      if (
        this.reason === null &&
        this.consecutiveFailures < DOWN_AFTER_CONSECUTIVE_FAILURES
      ) {
        return;
      }

      this.open(this.reason ?? "provider_down", now);
      return;
    }

    this.open(kind, now);
  }

  snapshot(now: Date = new Date()): CircuitSnapshot {
    return {
      state:
        this.reason === null
          ? "closed"
          : this.retryAt && now < this.retryAt
            ? "open"
            : "half_open",
      reason: this.reason,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
    };
  }

  private open(reason: CircuitReason, now: Date): void {
    const { firstMs, maxMs } = COOLDOWNS[reason];

    // Doubling only while the same trouble lasts; a new kind starts over.
    this.cooldownMs =
      this.reason === reason && this.cooldownMs > 0
        ? Math.min(this.cooldownMs * 2, maxMs)
        : firstMs;

    if (this.reason !== reason || this.openedAt === null) this.openedAt = now;

    this.reason = reason;
    this.retryAt = new Date(now.getTime() + this.cooldownMs);
  }
}

export { COOLDOWNS, DOWN_AFTER_CONSECUTIVE_FAILURES, ProviderCircuit };
export type { CircuitReason, CircuitSnapshot };
