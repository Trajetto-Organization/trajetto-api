import { env } from "@/env";
import { liveConsumers } from "@/shared/health/process-heartbeat";
import { logger } from "@/shared/logging/logger";

import type { DeliveryLane } from "./pipeline-rules";

const log = logger.child({ component: "provider-caps" });

/**
 * The providers' global concurrency caps, divided by the live processes
 * (plano-escala F3-15a; decision D45).
 *
 * Each process that claims a delivery lane runs its own pool, so a cap per
 * process multiplies with the processes: WhatsApp at 5 in flight per
 * process is 10 against Meta with a second worker, and what the contract
 * with Meta or Resend allows is the platform's, not one process's. A
 * provider's cap is set once for the whole platform
 * (WHATSAPP_GLOBAL_CONCURRENCY, EMAIL_GLOBAL_CONCURRENCY,
 * PUSH_GLOBAL_CONCURRENCY; 0, the default, is no cap: the lane's own
 * concurrency, as before) and each process takes its part:
 * floor(global / divisor), never below 1.
 *
 * The divisor is the live processes that claim the provider's lane, read
 * from process_heartbeat.queues, and it must not shrink on a hiccup: a
 * failed read that made every process think it was alone would put each of
 * them at the whole cap at once — the contract times the processes. So the
 * divisor is the greatest of the processes live now, the most seen in the
 * last ten minutes (a process that just went away still counts while the
 * others may not have seen it go) and ROLE_EXPECTED_CONSUMERS (the owner's
 * floor), never below 1; and when the read fails, the last divisor stands.
 * A process going away gives its part back to the others only ten minutes
 * later: the safe side of a contract.
 */

type Provider = "whatsapp" | "email" | "push";

const PROVIDERS: readonly Provider[] = ["whatsapp", "email", "push"];

/** The lane each provider's channel is sent on (pipeline-rules.ts). */
const PROVIDER_LANE: Record<Provider, DeliveryLane> = {
  whatsapp: "external",
  email: "external",
  push: "internal",
};

/** How long the most live processes seen keeps the divisor up. */
const DIVISOR_HIGH_WATER_MS = 10 * 60_000;

/** The provider a channel calls; null for the channels that call none. */
function providerOfChannel(channel: string): Provider | null {
  switch (channel) {
    case "WHATSAPP":
      return "whatsapp";
    case "EMAIL":
      return "email";
    case "PUSH":
      return "push";
    default:
      return null;
  }
}

/** The channels a provider's rows are claimed by. */
function channelsOf(provider: Provider): string[] {
  return [provider.toUpperCase()];
}

/**
 * This process's part of a global cap: floor(global / divisor), never below
 * 1 (a process with no part would never send, and the lane would stall).
 * Null when there is no global cap (0 or less).
 */
function perProcessCap(global: number, divisor: number): number | null {
  if (!Number.isFinite(global) || global <= 0) return null;

  const share = Math.floor(global / Math.max(1, Math.floor(divisor)));

  return Math.max(1, share);
}

interface StableDivisorDeps {
  /** The processes live now; null or a throw when it cannot be read. */
  read: () => Promise<number | null>;

  /** The owner's floor (ROLE_EXPECTED_CONSUMERS). */
  expected: () => number;

  now?: () => number;
  windowMs?: number;
}

/**
 * A divisor that does not shrink on a hiccup (see the top of the file).
 * `refresh` reads the live processes and answers the divisor; `current`
 * answers the last one without reading.
 */
function createStableDivisor(deps: StableDivisorDeps) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? DIVISOR_HIGH_WATER_MS;

  let samples: Array<{ at: number; live: number }> = [];
  let last: number | null = null;
  let failing = false;

  const floor = (): number => Math.max(1, Math.floor(deps.expected() || 0));

  return {
    async refresh(): Promise<number> {
      let live: number | null;

      try {
        live = await deps.read();
      } catch {
        live = null;
      }

      if (live === null || !Number.isFinite(live)) {
        // The last divisor stands; with none yet, the owner's floor.
        if (!failing) {
          failing = true;
          log.warn(
            { divisor: last ?? floor() },
            "live consumers could not be read; the last provider cap divisor stands",
          );
        }

        last = Math.max(last ?? 1, floor());

        return last;
      }

      failing = false;

      const at = now();

      samples = samples.filter((sample) => at - sample.at <= windowMs);
      samples.push({ at, live });

      const seen = Math.max(...samples.map((sample) => sample.live));

      last = Math.max(1, Math.floor(live), seen, floor());

      return last;
    },

    current(): number {
      return last ?? floor();
    },
  };
}

type StableDivisor = ReturnType<typeof createStableDivisor>;

interface ProviderCapsDeps {
  /** Each provider's global cap; 0 or less is none. */
  globals: () => Record<Provider, number>;

  /** The live processes claiming a lane, as process_heartbeat says. */
  live: (lane: DeliveryLane) => Promise<number | null>;

  expected: () => number;

  now?: () => number;
}

/**
 * The global caps of a process: which lanes have one, and each provider's
 * part for this process, by its lane's stable divisor.
 */
function createProviderCaps(deps: ProviderCapsDeps) {
  const divisors: Record<DeliveryLane, StableDivisor> = {
    internal: createStableDivisor({
      read: () => deps.live("internal"),
      expected: deps.expected,
      now: deps.now,
    }),
    external: createStableDivisor({
      read: () => deps.live("external"),
      expected: deps.expected,
      now: deps.now,
    }),
  };

  const capped = (provider: Provider): boolean =>
    (deps.globals()[provider] ?? 0) > 0;

  return {
    /** The providers of `lane` that have a global cap. */
    providersOf(lane: DeliveryLane): Provider[] {
      return PROVIDERS.filter(
        (provider) => PROVIDER_LANE[provider] === lane && capped(provider),
      );
    },

    /** Reads the lane's live processes again (cached by the reader). */
    async refresh(lane: DeliveryLane): Promise<number> {
      return divisors[lane].refresh();
    },

    /** The lane's divisor as last read. */
    divisor(lane: DeliveryLane): number {
      return divisors[lane].current();
    },

    /**
     * This process's part of `provider`'s global cap, as last read; Infinity
     * when the provider has none.
     */
    limitOf(provider: Provider): number {
      const part = perProcessCap(
        deps.globals()[provider] ?? 0,
        divisors[PROVIDER_LANE[provider]].current(),
      );

      return part ?? Number.POSITIVE_INFINITY;
    },
  };
}

type ProviderCaps = ReturnType<typeof createProviderCaps>;

/** This process's caps, on the runtime's env and heartbeat reader. */
const providerCaps = createProviderCaps({
  globals: () => ({
    whatsapp: env.WHATSAPP_GLOBAL_CONCURRENCY,
    email: env.EMAIL_GLOBAL_CONCURRENCY,
    push: env.PUSH_GLOBAL_CONCURRENCY,
  }),
  live: (lane) => liveConsumers(lane),
  expected: () => env.ROLE_EXPECTED_CONSUMERS,
});

export {
  DIVISOR_HIGH_WATER_MS,
  PROVIDER_LANE,
  PROVIDERS,
  channelsOf,
  createProviderCaps,
  createStableDivisor,
  perProcessCap,
  providerCaps,
  providerOfChannel,
};
export type { Provider, ProviderCaps, ProviderCapsDeps, StableDivisor };
