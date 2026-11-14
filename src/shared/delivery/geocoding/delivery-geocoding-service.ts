import {
  hasFallbackQuery,
  type GeocodableAddress,
  type GeocodeOutcome,
  type GeocodeQuery,
} from "@/shared/services/proof-location/address-geocoder";

import { fallbackAgrees } from "./fallback-agreement";
import type { GeocodingBudget } from "./geocoding-budget";
import type { GeocodingGate, GeocodingPauseReason } from "./geocoding-gate";
import type {
  GeocodingClaim,
  GeocodingSettlement,
  IDeliveryGeocodingRepository,
} from "./geocoding-repository";
import { GEOCODING_MAX_ATTEMPTS } from "./geocoding-rules";

/**
 * One run of the geocoding (plan of 02/11/2026, E1; decision D15): claim
 * open deliveries without a point, ask the provider one at a time within
 * the day's budget and the second's slot, and settle each one:
 *
 * - ADDRESS or STREET: the point, geo_source GEOCODER, and the level;
 * - NEIGHBORHOOD or CITY: COARSE, with the level but no point — the geofence
 *   reads it as "não avaliável" and the map as "não localizado";
 * - NOT_FOUND: settled until the address changes;
 * - FAILED: tried again after the back-off, up to GEOCODING_MAX_ATTEMPTS.
 *
 * A NOT_FOUND or COARSE answer to the full address is asked once more as
 * street, city and UF alone (GeocodeQuery STRUCTURED), and the better
 * answer wins: a number, a district or a CEP the map does not know must not
 * cost a street it does. A point from that second answer stands only when
 * nothing about the delivery contradicts it (fallback-agreement.ts): the
 * street asked, named once in the city, in the delivery's district and CEP
 * when the map says, near the district the first answer reached.
 *
 * What is about the provider and not the address is never charged to the
 * delivery (owner's report of 09/11/2026). A refusal (key, URL) or a 429
 * pauses every replica (GeocodingGate) and gives the run's claims back
 * unasked (release); three failures in a row stop the run the same way —
 * the provider is down, and asking the rest would burn their attempts.
 *
 * Two entry points. runOnce is the minute's job: the open stops of
 * unfinished routes first (claimOpenStops), then the newest. runFor
 * is the lookup a create, an address edit or a routing starts after its
 * commit (geocode-soon.ts), over those deliveries only: it settles only an
 * answer about the address and gives anything else back to the job. Off
 * the request path, both: no answer waits for the provider.
 */

interface GeocodingRunOptions {
  /** Deliveries claimed per run (the cron runs every minute). */
  batchSize: number;
  /** Pause between two calls, to stay under the provider's rate. */
  spacingMs: number;
  /** FAILED answers in a row that stop the run: the provider is down. */
  failureStreak: number;
  /** How long to wait for the next second when its slots are taken. */
  slotWaitMs: number;
  /** How many times to try for a slot before giving the run back. */
  slotTries: number;
}

/** Why a run stopped before its last claim; the rest were released. */
type GeocodingStop =
  "REFUSED" | "RATE_LIMITED" | "FAILURES" | "BUDGET" | "NO_SLOT";

/**
 * A settle that ended the lookup — the stop's screen changes: a point, or
 * "não localizado". A FAILED still under the cap changes nothing to see.
 */
interface SettledLookup {
  id: string;
  businessId: string;
  kind: GeocodingSettlement["kind"];
}

/** The account's pause as its key holds it (geocoding-gate.ts). */
interface GeocodingPauseState {
  reason: GeocodingPauseReason;
  /** Null when the value has no readable deadline. */
  until: Date | null;
  /** The provider's HTTP status that caused it; null when not kept. */
  status: number | null;
}

/**
 * What holds the lookups, for the log's transition line
 * (geocoding-runtime.ts): the account's pause — the one this run set, or
 * the one that kept it from asking — and today's count.
 */
interface GeocodingHoldState {
  pause: GeocodingPauseState | null;
  /** Lookups counted today across every replica; null when not read. */
  used: number | null;
}

interface GeocodingRunResult {
  claimed: number;
  resolved: number;
  coarse: number;
  notFound: number;
  failed: number;
  /** Claims given back unasked, for the next run. */
  released: number;
  /** Why the run asked nothing, when it did not. */
  skipped?: "BUDGET" | "PAUSED";
  stoppedBy?: GeocodingStop;
  /**
   * The pause this run set, or what kept it from asking (a pause, the
   * day's count), when known: the log says it once per change, at info.
   */
  hold?: GeocodingHoldState | null;
  /**
   * The HTTP status of every answer that was not about the address (null:
   * no answer at all), for the job's log — the run's whole diagnosis.
   */
  providerStatuses: Array<number | null>;
  settled: SettledLookup[];
}

type Geocode = (
  address: GeocodableAddress,
  query: GeocodeQuery,
) => Promise<GeocodeOutcome>;

/** Told after a run about the lookups it ended (geocoding-announcer.ts). */
type AnnounceSettled = (settled: SettledLookup[]) => Promise<void>;

/**
 * The account's pause and today's count, read only when a run asks
 * nothing — the gate and the budget decide, this only says why, for the
 * log. Null when unreadable.
 */
type ReadHold = (now: Date) => Promise<GeocodingHoldState | null>;

interface DeliveryGeocodingDeps {
  repository: IDeliveryGeocodingRepository;
  geocode: Geocode;
  budget: GeocodingBudget;
  gate: GeocodingGate;
  announce?: AnnounceSettled;
  readHold?: ReadHold;
  options?: Partial<GeocodingRunOptions>;
}

/**
 * One call a second at most, the gate's rate (GEOCODING_CALLS_PER_SECOND):
 * the run spaces its own calls by that much, and the gate holds every
 * replica and path together to it.
 */
const GEOCODING_RUN_DEFAULTS: GeocodingRunOptions = {
  batchSize: 20,
  spacingMs: 1_000,
  failureStreak: 3,
  slotWaitMs: 400,
  slotTries: 3,
};

/** A refusal is configuration: somebody has to fix it, so not every minute. */
const REFUSED_PAUSE_MS = 15 * 60_000;

/** A per-second or per-minute 429: the next minute's run asks again. */
const SHORT_RATE_PAUSE_MS = 60_000;

/** LocationIQ's daily quota starts again at midnight UTC, as our budget. */
function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/** Until when a refusal or a 429 pauses every replica. */
function pauseUntil(
  outcome: Extract<GeocodeOutcome, { kind: "REFUSED" | "RATE_LIMITED" }>,
  now: Date,
): Date {
  if (outcome.kind === "REFUSED") {
    return new Date(now.getTime() + REFUSED_PAUSE_MS);
  }

  return outcome.scope === "DAY"
    ? nextUtcMidnight(now)
    : new Date(now.getTime() + SHORT_RATE_PAUSE_MS);
}

/** What the pause key says, for the route read (geocoding-hold.ts). */
function pauseReason(
  outcome: Extract<GeocodeOutcome, { kind: "REFUSED" | "RATE_LIMITED" }>,
): GeocodingPauseReason {
  if (outcome.kind === "REFUSED") return "REFUSED";

  return outcome.scope === "DAY" ? "QUOTA" : "BURST";
}

function settlementOf(outcome: GeocodeOutcome): GeocodingSettlement {
  switch (outcome.kind) {
    case "FOUND":
      return outcome.precision === "ADDRESS" || outcome.precision === "STREET"
        ? {
            kind: "RESOLVED",
            latitude: outcome.latitude,
            longitude: outcome.longitude,
            precision: outcome.precision,
          }
        : { kind: "COARSE", precision: outcome.precision };
    case "NOT_FOUND":
      return { kind: "NOT_FOUND" };
    // REFUSED, RATE_LIMITED and DISABLED never reach here (the run gives
    // the claim back); if one did, the address is simply tried again later.
    case "FAILED":
    case "REFUSED":
    case "RATE_LIMITED":
    case "DISABLED":
      return { kind: "FAILED" };
  }
}

/** How close an answer came to the door: the better of two answers wins. */
function answerRank(outcome: GeocodeOutcome): number {
  if (outcome.kind !== "FOUND") return 0;

  switch (outcome.precision) {
    case "ADDRESS":
      return 4;
    case "STREET":
      return 3;
    case "NEIGHBORHOOD":
      return 2;
    case "CITY":
      return 1;
  }
}

/** An answer about the address that did not reach the street. */
function fallsShort(outcome: GeocodeOutcome): boolean {
  return (
    outcome.kind === "NOT_FOUND" ||
    (outcome.kind === "FOUND" &&
      (outcome.precision === "NEIGHBORHOOD" || outcome.precision === "CITY"))
  );
}

/** An answer about the address itself, which the run may settle. */
function isAboutTheAddress(outcome: GeocodeOutcome): boolean {
  return outcome.kind === "FOUND" || outcome.kind === "NOT_FOUND";
}

/** The settles the screens show: a point, or the lookup over. */
function endsTheLookup(
  settlement: GeocodingSettlement,
  claim: GeocodingClaim,
): boolean {
  return (
    settlement.kind !== "FAILED" || claim.attempts >= GEOCODING_MAX_ATTEMPTS
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One run's state: whether a call was made yet, for the spacing. */
interface RunState {
  calls: number;
}

class DeliveryGeocodingService {
  private readonly repository: IDeliveryGeocodingRepository;
  private readonly geocode: Geocode;
  private readonly budget: GeocodingBudget;
  private readonly gate: GeocodingGate;
  private readonly announce: AnnounceSettled | undefined;
  private readonly readHold: ReadHold | undefined;
  private readonly options: GeocodingRunOptions;

  constructor(deps: DeliveryGeocodingDeps) {
    this.repository = deps.repository;
    this.geocode = deps.geocode;
    this.budget = deps.budget;
    this.gate = deps.gate;
    this.announce = deps.announce;
    this.readHold = deps.readHold;
    this.options = { ...GEOCODING_RUN_DEFAULTS, ...deps.options };
  }

  /**
   * The minute's job, every company: the claimable open stops of unfinished
   * routes first — what a driver will visit and a route page shows, which
   * must not wait behind a newer spreadsheet of a thousand rows — then the
   * newest of the rest, to the batch.
   */
  async runOnce(now: Date = new Date()): Promise<GeocodingRunResult> {
    const result = emptyResult();

    if (await this.gate.paused(now)) return this.held(result, "PAUSED", now);

    // Claim only what the budget can still pay for: a claim stamps the
    // attempt, and a claimed row never asked would wait out a back-off for
    // nothing.
    const room = Math.min(
      this.options.batchSize,
      await this.budget.remaining(now),
    );

    if (room <= 0) return this.held(result, "BUDGET", now);

    // The second claim cannot take the first's rows again: they are leased.
    const routed = await this.repository.claimOpenStops(room, now);
    const claims =
      routed.length < room
        ? [
            ...routed,
            ...(await this.repository.claim(room - routed.length, now)),
          ]
        : routed;

    result.claimed = claims.length;

    await this.work(claims, now, "JOB", result);

    return result;
  }

  /**
   * Right after a commit: these deliveries of this company, at most a
   * batch, when they are still claimable (no point, not settled, not in a
   * back-off). Anything but an answer about the address gives the claim
   * back to the minute's job, unspent.
   */
  async runFor(
    businessId: string,
    deliveryIds: readonly string[],
    now: Date = new Date(),
  ): Promise<GeocodingRunResult> {
    const result = emptyResult();
    const ids = [...new Set(deliveryIds)].slice(0, this.options.batchSize);

    if (ids.length === 0) return result;

    if (await this.gate.paused(now)) return this.held(result, "PAUSED", now);

    const room = Math.min(ids.length, await this.budget.remaining(now));

    if (room <= 0) return this.held(result, "BUDGET", now);

    const claims = await this.repository.claimByIds(ids, businessId, room, now);

    result.claimed = claims.length;

    await this.work(claims, now, "SOON", result);

    return result;
  }

  /** A run that asked nothing, with what held it when that can be read. */
  private async held(
    result: GeocodingRunResult,
    skipped: "BUDGET" | "PAUSED",
    now: Date,
  ): Promise<GeocodingRunResult> {
    return {
      ...result,
      skipped,
      ...(this.readHold && { hold: await this.readHold(now) }),
    };
  }

  private async work(
    claims: GeocodingClaim[],
    now: Date,
    mode: "JOB" | "SOON",
    result: GeocodingRunResult,
  ): Promise<void> {
    const run: RunState = { calls: 0 };
    let failures = 0;

    try {
      for (const [index, claim] of claims.entries()) {
        const outcome = await this.lookUp(claim, now, run);

        // No budget or no slot left: nothing more is asked in this run.
        if (typeof outcome === "string") {
          result.stoppedBy = outcome;
          await this.releaseFrom(claims, index, result);

          return;
        }

        if (outcome.kind === "REFUSED" || outcome.kind === "RATE_LIMITED") {
          const until = pauseUntil(outcome, now);
          const reason = pauseReason(outcome);

          result.providerStatuses.push(outcome.status);
          result.stoppedBy = outcome.kind;
          result.hold = {
            pause: { reason, until, status: outcome.status },
            used: null,
          };

          // The status goes with the pause, so the log and the health page
          // say which answer of the provider holds every replica.
          await this.gate.pause(until, now, reason, outcome.status);
          await this.releaseFrom(claims, index, result);

          return;
        }

        if (mode === "SOON" && !isAboutTheAddress(outcome)) {
          if (outcome.kind === "FAILED") {
            result.providerStatuses.push(outcome.status);
          }

          result.stoppedBy = "FAILURES";
          await this.releaseFrom(claims, index, result);

          return;
        }

        const settlement = settlementOf(outcome);
        const written = await this.repository.settle(claim, settlement, now);

        tally(result, settlement);

        if (written && endsTheLookup(settlement, claim)) {
          result.settled.push({
            id: claim.id,
            businessId: claim.businessId,
            kind: settlement.kind,
          });
        }

        if (settlement.kind !== "FAILED") {
          failures = 0;
          continue;
        }

        result.providerStatuses.push(
          outcome.kind === "FAILED" ? outcome.status : null,
        );
        failures += 1;

        if (failures >= this.options.failureStreak) {
          result.stoppedBy = "FAILURES";
          await this.releaseFrom(claims, index + 1, result);

          return;
        }
      }
    } finally {
      // Whatever ended the run, the screens hear about what it settled.
      if (this.announce && result.settled.length > 0) {
        await this.announce(result.settled);
      }
    }
  }

  /**
   * The free-text address, then — when that fell short of the street and
   * there was more to drop — street, city and UF alone. The better answer
   * wins, a point from the second only when it agrees with the delivery
   * (fallbackAgrees); a provider error on the second call is the lookup's
   * outcome (the address is asked again later, both ways). A string: the
   * run has no budget or no slot left for this call.
   */
  private async lookUp(
    claim: GeocodingClaim,
    now: Date,
    run: RunState,
  ): Promise<GeocodeOutcome | "BUDGET" | "NO_SLOT"> {
    const first = await this.ask(claim, "FREE_TEXT", now, run);

    if (typeof first === "string") return first;

    if (!fallsShort(first) || !hasFallbackQuery(claim)) return first;

    const second = await this.ask(claim, "STRUCTURED", now, run);

    if (typeof second === "string") return second;

    if (!isAboutTheAddress(second)) return second;

    if (!fallbackAgrees(claim, first, second)) return first;

    return answerRank(second) > answerRank(first) ? second : first;
  }

  /** One provider call: the budget, the spacing, the slot, the call. */
  private async ask(
    claim: GeocodingClaim,
    query: GeocodeQuery,
    now: Date,
    run: RunState,
  ): Promise<GeocodeOutcome | "BUDGET" | "NO_SLOT"> {
    if ((await this.budget.remaining(now)) <= 0) return "BUDGET";

    if (run.calls > 0 && this.options.spacingMs > 0) {
      await sleep(this.options.spacingMs);
    }

    if (!(await this.slot())) return "NO_SLOT";

    run.calls += 1;

    const outcome = await this.geocode(claim, query);

    await this.budget.spend(now);

    return outcome;
  }

  /** The second's slot, waiting for the next second a few times. */
  private async slot(): Promise<boolean> {
    for (let attempt = 1; attempt <= this.options.slotTries; attempt += 1) {
      if (await this.gate.takeSlot()) return true;

      if (attempt < this.options.slotTries && this.options.slotWaitMs > 0) {
        await sleep(this.options.slotWaitMs);
      }
    }

    return false;
  }

  private async releaseFrom(
    claims: GeocodingClaim[],
    from: number,
    result: GeocodingRunResult,
  ): Promise<void> {
    for (const claim of claims.slice(from)) {
      if (await this.repository.release(claim)) result.released += 1;
    }
  }
}

function emptyResult(): GeocodingRunResult {
  return {
    claimed: 0,
    resolved: 0,
    coarse: 0,
    notFound: 0,
    failed: 0,
    released: 0,
    providerStatuses: [],
    settled: [],
  };
}

function tally(
  result: GeocodingRunResult,
  settlement: GeocodingSettlement,
): void {
  if (settlement.kind === "RESOLVED") result.resolved += 1;
  else if (settlement.kind === "COARSE") result.coarse += 1;
  else if (settlement.kind === "NOT_FOUND") result.notFound += 1;
  else result.failed += 1;
}

export {
  DeliveryGeocodingService,
  GEOCODING_RUN_DEFAULTS,
  REFUSED_PAUSE_MS,
  SHORT_RATE_PAUSE_MS,
  nextUtcMidnight,
  pauseReason,
  pauseUntil,
  settlementOf,
};
export type {
  AnnounceSettled,
  DeliveryGeocodingDeps,
  Geocode,
  GeocodingHoldState,
  GeocodingPauseState,
  GeocodingRunOptions,
  GeocodingRunResult,
  GeocodingStop,
  ReadHold,
  SettledLookup,
};
