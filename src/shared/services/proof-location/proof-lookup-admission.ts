import type { Redis } from "ioredis";

import { env } from "@/env";
import {
  GEOCODING_SCOPES,
  createGeocodingBudget,
  type GeocodingBudget,
} from "@/shared/delivery/geocoding/geocoding-budget";
import {
  createRedisGeocodingGate,
  createRedisProofGate,
  geocodingRatesFromEnv,
  type GeocodingGate,
  type ProofGate,
} from "@/shared/delivery/geocoding/geocoding-gate";
import {
  GEOCODING_KEYS,
  type GeocodingKeys,
} from "@/shared/delivery/geocoding/geocoding-keys";
import { logger } from "@/shared/logging/logger";
import {
  ProviderQuotaRepository,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";

/**
 * Whether the proof's reverse lookup may go out now (plano-escala F2-32;
 * decision D40). It shared the geocoder's key and account and counted
 * nowhere: a spreadsheet's job could take the second it needed, and the
 * provider's 429 left the receipt without the GPS address for a day. Now
 * it takes, in this order:
 *
 * 0. nothing at all once its day is spent or switched off (a read of the
 *    day, below): a slot enters the minute's log the job and the search
 *    count, so receipts opened while the day pays for no lookup would
 *    starve them for a minute each (review of F2-32);
 * 1. a slot of its own second (GEOCODING_PROOF_RESERVED_PER_SECOND, which
 *    nothing else takes) or, when that one is full, a free slot of the
 *    shared rate (the search's ceilings): a burst of receipts opened at
 *    once — an ERP opening its proof links — must not print most of them
 *    without the address while the job is idle. Tried a few times a little
 *    apart, since the receipt is stored once and a lookup put off prints it
 *    without the address; never while the account's quota or a burst holds
 *    every path;
 * 2. a unit of its own day ("proof-reverse", PROOF_REVERSE_DAILY_BUDGET).
 *
 * Both fail CLOSED, as the rest of the geocoder: unreadable, the receipt
 * prints the labelled fallback and records nothing, so the next one asks
 * again. Unwired (unit tests, scripts), nothing is admitted.
 */
interface ProofLookupAdmission {
  admit(now: Date): Promise<boolean>;
}

interface ProofLookupAdmissionOptions {
  gate: ProofGate;
  /** The shared rate, borrowed when the proof's own second is full. */
  shared?: Pick<GeocodingGate, "takeSlot">;
  budget: GeocodingBudget;
  /** How many times to try for a slot. */
  slotTries?: number;
  /** The wait between two tries: five tries 400 ms apart span 1.6 s. */
  slotWaitMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function createProofLookupAdmission({
  gate,
  shared,
  budget,
  slotTries = 5,
  slotWaitMs = 400,
}: ProofLookupAdmissionOptions): ProofLookupAdmission {
  return {
    async admit(now) {
      // The day before the slot, as the job's call reads it (ask in
      // delivery-geocoding-service.ts); the take below still decides.
      if ((await budget.remaining(now)) <= 0) return false;

      for (let attempt = 1; attempt <= slotTries; attempt += 1) {
        const slot = await gate.takeProofSlot();

        // The account is held: the provider would only answer 429.
        if (slot === "PAUSED") return false;

        // The slot first, the day's unit after: a slot not used is a
        // second's, a unit not used is a lookup of the day.
        if (slot === "OK" || (shared && (await shared.takeSlot()))) {
          return budget.take(now);
        }

        if (attempt < slotTries && slotWaitMs > 0) await sleep(slotWaitMs);
      }

      return false;
    },
  };
}

/** Nothing is asked: the process never wired the proof's lane. */
const closedProofLookupAdmission: ProofLookupAdmission = {
  admit: async () => false,
};

const log = logger.child({ component: "proof-location" });

let admission: ProofLookupAdmission = closedProofLookupAdmission;

/**
 * Wires the proof's lane on the request path's fail-fast Redis connection
 * (http.ts, the rate-limit one, like the search and the geocoding hold) and
 * its day on Postgres. The keys are production's, shared with every
 * replica; only an E2E file passes its own.
 */
function configureProofLookupAdmission(
  redis: Redis,
  keys: GeocodingKeys = GEOCODING_KEYS,
  quota: IProviderQuotaRepository = new ProviderQuotaRepository(),
): void {
  // Debug, not warn: during an outage every receipt would write a line, and
  // the connection log already says Redis is gone.
  const onError = (err: unknown) =>
    log.debug({ err }, "proof lookup limits unreadable");

  const rates = geocodingRatesFromEnv();

  admission = createProofLookupAdmission({
    gate: createRedisProofGate(redis, {
      perSecond: env.GEOCODING_PROOF_RESERVED_PER_SECOND,
      onError,
      keys,
    }),
    // A free slot of the shared rate, under the search's ceilings: what
    // the job and the search leave this second.
    shared: createRedisGeocodingGate(redis, {
      perSecond: rates.perSecond,
      perMinute: rates.perMinute,
      onError,
      keys,
    }),
    budget: createGeocodingBudget({
      quota,
      scope: GEOCODING_SCOPES.proof,
      limit: () => env.PROOF_REVERSE_DAILY_BUDGET,
      onError,
    }),
  });
}

/** The process's lane, read at call time (http.ts wires it after import). */
function proofLookupAdmission(): ProofLookupAdmission {
  return admission;
}

export {
  closedProofLookupAdmission,
  configureProofLookupAdmission,
  createProofLookupAdmission,
  proofLookupAdmission,
};
export type { ProofLookupAdmission, ProofLookupAdmissionOptions };
