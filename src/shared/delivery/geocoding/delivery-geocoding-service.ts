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
import {
  GEOCODING_BATCH_SIZE_DEFAULT,
  GEOCODING_CALLS_PER_SECOND_DEFAULT,
  GEOCODING_MAX_ATTEMPTS,
  GEOCODING_RUN_BUDGET_DEFAULT_MS,
  GEOCODING_VERDICT_REUSE_DAYS_DEFAULT,
} from "./geocoding-rules";

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
 * A delivery at a door another delivery of the company already located
 * (address-key.ts) takes that point before anything is asked (owner's
 * report of 14/11/2026): settled as GEOCODER with the same guards as an
 * answer, without the budget, the slot or a call — a repeated address no
 * longer spends the provider's day (address-point-reuse.ts).
 *
 * Nor does a door the provider could not place (plano-escala F2-33): a
 * delivery at a door where the provider answered NOT_FOUND or COARSE for
 * another delivery of the company within GEOCODING_VERDICT_REUSE_DAYS
 * takes that verdict, with its date, so a bad address costs one lookup a
 * window per company instead of one per delivery — a customer's
 * spreadsheet repeats its doors. Never across companies; a pin at the
 * door later still reaches it, as it reaches any delivery without a point
 * (address-point-propagation.ts).
 *
 * Two entry points. runOnce is the minute's job: the open stops of
 * unfinished routes first (claimOpenStops), then the newest, a batch at a
 * time, claiming again while each batch comes back full and the run's time
 * lasts (plano-escala F2-31: one batch a minute put a spreadsheet of 20,000
 * rows a day behind). runFor is the lookup a create, an address edit or a
 * routing starts after its commit (geocode-soon.ts), over those deliveries
 * only: it settles only an answer about the address and gives anything
 * else back to the job. Off the request path, both: no answer waits for
 * the provider.
 */

interface GeocodingRunOptions {
  /** Deliveries one claim takes (DELIVERY_GEOCODING_BATCH_SIZE). */
  batchSize: number;
  /**
   * The least time between the starts of two calls of one run, to stay
   * under the provider's rate: 1000 / GEOCODING_CALLS_PER_SECOND.
   */
  spacingMs: number;
  /**
   * How long the minute's job keeps claiming, and working what it claimed
   * (DELIVERY_GEOCODING_RUN_BUDGET_MS). Past it, nothing more is asked:
   * what is left of the batch goes back for the next run.
   */
  runBudgetMs: number;
  /** FAILED answers in a row that stop the run: the provider is down. */
  failureStreak: number;
  /** How long to wait for the next second when its slots are taken. */
  slotWaitMs: number;
  /** How many times to try for a slot before giving the run back. */
  slotTries: number;
  /**
   * How many days a NOT_FOUND or COARSE answer about a door stands for the
   * company's other deliveries there (GEOCODING_VERDICT_REUSE_DAYS); 0
   * asks the provider for every delivery, as before.
   */
  verdictReuseDays: number;
}

/**
 * Why a run stopped before its last claim; the rest were released.
 * DEADLINE: the job's time ran out mid-batch (runBudgetMs).
 */
type GeocodingStop =
  "REFUSED" | "RATE_LIMITED" | "FAILURES" | "BUDGET" | "NO_SLOT" | "DEADLINE";

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
  /**
   * Settled with the point another delivery of the company has at the
   * same door: nothing asked, nothing spent.
   */
  reused: number;
  /**
   * Settled with the verdict without a point (NOT_FOUND, COARSE) the
   * provider gave about the same door of the company within the window:
   * nothing asked, nothing spent.
   */
  reusedVerdicts: number;
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
  /** Milliseconds, for the run's time; Date.now by default. */
  clock?: () => number;
  /**
   * True once the process is shutting down (lifecycle/draining.ts): the
   * job claims no other batch, so its run ends inside the shutdown's
   * deadline instead of leaving leased rows behind.
   */
  stopping?: () => boolean;
}

/** The spacing of one run's calls at `perSecond` calls a second. */
function spacingFor(perSecond: number): number {
  return Math.ceil(1_000 / Math.max(1, perSecond));
}

/**
 * One call a second at most by default, the gate's rate
 * (GEOCODING_CALLS_PER_SECOND): the run spaces the starts of its own calls
 * by that much, and the gate holds every replica and path together to it.
 */
const GEOCODING_RUN_DEFAULTS: GeocodingRunOptions = {
  batchSize: GEOCODING_BATCH_SIZE_DEFAULT,
  spacingMs: spacingFor(GEOCODING_CALLS_PER_SECOND_DEFAULT),
  runBudgetMs: GEOCODING_RUN_BUDGET_DEFAULT_MS,
  failureStreak: 3,
  slotWaitMs: 400,
  slotTries: 3,
  verdictReuseDays: GEOCODING_VERDICT_REUSE_DAYS_DEFAULT,
};

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * One run's state: when its last call started, for the spacing, and when
 * it must stop asking (the job's runBudgetMs; never for runFor).
 */
interface RunState {
  lastCallAt: number | null;
  deadline: number;
}

class DeliveryGeocodingService {
  private readonly repository: IDeliveryGeocodingRepository;
  private readonly geocode: Geocode;
  private readonly budget: GeocodingBudget;
  private readonly gate: GeocodingGate;
  private readonly announce: AnnounceSettled | undefined;
  private readonly readHold: ReadHold | undefined;
  private readonly options: GeocodingRunOptions;
  private readonly clock: () => number;
  private readonly stopping: () => boolean;

  constructor(deps: DeliveryGeocodingDeps) {
    this.repository = deps.repository;
    this.geocode = deps.geocode;
    this.budget = deps.budget;
    this.gate = deps.gate;
    this.announce = deps.announce;
    this.readHold = deps.readHold;
    this.options = { ...GEOCODING_RUN_DEFAULTS, ...deps.options };
    this.clock = deps.clock ?? Date.now;
    this.stopping = deps.stopping ?? (() => false);
  }

  /**
   * The minute's job, every company: the claimable open stops of unfinished
   * routes first — what a driver will visit and a route page shows, which
   * must not wait behind a newer spreadsheet of a thousand rows — then the
   * newest of the rest, to the batch.
   *
   * Then another batch, while the last one came back full, nothing stopped
   * it (a pause, the budget, the slots, the provider failing, the time) and
   * the process is not shutting down: a backlog drains at the rate the env
   * allows instead of a batch a minute (F2-31). Each batch is claimed at
   * its own instant: `now` moved by the time the run has taken.
   */
  async runOnce(now: Date = new Date()): Promise<GeocodingRunResult> {
    const started = this.clock();
    const deadline = started + this.options.runBudgetMs;
    const at = () => new Date(now.getTime() + (this.clock() - started));
    const first = await this.runBatch(now, deadline);
    // The run's own lists: the first batch's were already handed to the
    // announcer, and the later batches' are added here.
    const total: GeocodingRunResult = {
      ...first,
      providerStatuses: [...first.providerStatuses],
      settled: [...first.settled],
    };

    let last = first;

    while (
      !last.skipped &&
      !last.stoppedBy &&
      last.claimed >= this.options.batchSize &&
      this.clock() < deadline &&
      !this.stopping()
    ) {
      last = await this.runBatch(at(), deadline);
      absorb(total, last);
    }

    return total;
  }

  /** One batch of the minute's job: claim, then work what was claimed. */
  private async runBatch(
    now: Date,
    deadline: number,
  ): Promise<GeocodingRunResult> {
    const result = emptyResult();

    // A paused run claims nothing, not even for a reuse, which needs no
    // provider: a reuse-only claim would take and give back the same head
    // of the queue every minute. A queued delivery at a located door waits
    // for the pause, or for a pin at its door (docs/arquitetura.md).
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

    await this.work(claims, now, "JOB", result, deadline);

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

    await this.work(claims, now, "SOON", result, Number.POSITIVE_INFINITY);

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
    deadline: number,
  ): Promise<void> {
    const run: RunState = { lastCallAt: null, deadline };
    let failures = 0;

    try {
      for (const [index, claim] of claims.entries()) {
        // The job's time is up: what is left of the batch goes back
        // unasked for the next run, instead of holding its lease while a
        // run of the next minute starts.
        if (this.clock() >= run.deadline) {
          result.stoppedBy = "DEADLINE";
          await this.releaseFrom(claims, index, result);

          return;
        }

        if (await this.reuse(claim, now, result)) continue;

        if (await this.reuseVerdict(claim, now, result)) continue;

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
   * Settles the claim with the point another delivery of the company has
   * at the same door, when one has it: no budget, no slot, no call. The
   * settle's guards hold (the claim still current, no point yet, and the
   * point's root still holding it), the copy names that root, and a
   * written one is announced like a found one. One not written gives the
   * claim back: a pin got there first, or the root's point moved or went
   * in the meantime, and the next run reads the door again. A reuse says
   * nothing about the provider: the failure streak stays as it was. True
   * when the claim is done with.
   */
  private async reuse(
    claim: GeocodingClaim,
    now: Date,
    result: GeocodingRunResult,
  ): Promise<boolean> {
    const point = await this.repository.reusablePoint(claim, now);

    if (!point) return false;

    const written = await this.repository.settle(
      claim,
      {
        kind: "RESOLVED",
        latitude: point.latitude,
        longitude: point.longitude,
        precision: point.geo_precision,
        copiedFrom: point.geo_copied_from,
      },
      now,
    );

    if (!written) {
      if (await this.repository.release(claim)) result.released += 1;

      return true;
    }

    result.reused += 1;
    result.settled.push({
      id: claim.id,
      businessId: claim.businessId,
      kind: "RESOLVED",
    });

    return true;
  }

  /**
   * Settles the claim with the verdict without a point the provider gave
   * about the same door of the company within the window, when there is
   * one: no budget, no slot, no call. The copy keeps the verdict's date
   * (decidedAt), so copying a copy never stretches the window, and it is
   * announced like the provider's own: the stop reads "não localizado". One
   * not written (an address edit or a pin got there first) gives the claim
   * back. A reuse says nothing about the provider: the failure streak stays
   * as it was. True when the claim is done with.
   */
  private async reuseVerdict(
    claim: GeocodingClaim,
    now: Date,
    result: GeocodingRunResult,
  ): Promise<boolean> {
    const days = this.options.verdictReuseDays;

    if (days <= 0) return false;

    const verdict = await this.repository.reusableVerdict(
      claim,
      new Date(now.getTime() - days * DAY_MS),
    );

    if (!verdict) return false;

    const settlement: GeocodingSettlement =
      verdict.kind === "COARSE"
        ? {
            kind: "COARSE",
            precision: verdict.precision,
            decidedAt: verdict.decidedAt,
          }
        : { kind: "NOT_FOUND", decidedAt: verdict.decidedAt };

    if (!(await this.repository.settle(claim, settlement, now))) {
      if (await this.repository.release(claim)) result.released += 1;

      return true;
    }

    result.reusedVerdicts += 1;
    result.settled.push({
      id: claim.id,
      businessId: claim.businessId,
      kind: settlement.kind,
    });

    return true;
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

  /**
   * One provider call: the budget, the spacing, the slot, the day's unit,
   * the call. The
   * spacing counts from the start of the run's last call, so a provider
   * slower to answer than the spacing is not waited for twice.
   */
  private async ask(
    claim: GeocodingClaim,
    query: GeocodeQuery,
    now: Date,
    run: RunState,
  ): Promise<GeocodeOutcome | "BUDGET" | "NO_SLOT"> {
    if ((await this.budget.remaining(now)) <= 0) return "BUDGET";

    if (run.lastCallAt !== null && this.options.spacingMs > 0) {
      const wait = run.lastCallAt + this.options.spacingMs - this.clock();

      if (wait > 0) await sleep(wait);
    }

    if (!(await this.slot())) return "NO_SLOT";

    // Counted as it goes out, and only below the day's limit (F2-32): two
    // replicas at the last unit never both ask. A slot taken for a call
    // the day no longer pays for is a second's slot, not a lookup.
    if (!(await this.budget.take(now))) return "BUDGET";

    run.lastCallAt = this.clock();

    return this.geocode(claim, query);
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
    reused: 0,
    reusedVerdicts: 0,
    released: 0,
    providerStatuses: [],
    settled: [],
  };
}

/**
 * A later batch of the same run, added to the run's result: its counts,
 * its settles and statuses, and why it stopped. A batch that asked
 * nothing because the budget ran out is the run stopped by it (the next
 * run, held, says so); a pause set meanwhile by another path says nothing
 * here either way.
 */
function absorb(total: GeocodingRunResult, batch: GeocodingRunResult): void {
  total.claimed += batch.claimed;
  total.resolved += batch.resolved;
  total.coarse += batch.coarse;
  total.notFound += batch.notFound;
  total.failed += batch.failed;
  total.reused += batch.reused;
  total.reusedVerdicts += batch.reusedVerdicts;
  total.released += batch.released;
  total.providerStatuses.push(...batch.providerStatuses);
  total.settled.push(...batch.settled);

  if (batch.stoppedBy) {
    total.stoppedBy = batch.stoppedBy;
    total.hold = batch.hold;
  } else if (batch.skipped === "BUDGET") {
    total.stoppedBy = "BUDGET";
  }
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
  spacingFor,
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
