import type { Redis } from "ioredis";

import {
  countInFixedWindow,
  spendInFixedWindow,
} from "@/shared/services/fixed-window-counter";

/**
 * Counters for the public API that the per-key limiter cannot provide.
 *
 * The per-key ceiling (@fastify/rate-limit, keyed by the key's prefix) can
 * only run once `ensureApiKey` has looked the key up, and a made-up key is
 * refused with 401 before that. A flood of well-formed invented keys therefore
 * cost one database lookup each, with no limit at all, on the pool every
 * tenant shares. Stacking a second plugin limiter by address in front does
 * not work either: every handler the plugin builds shares one per-request
 * "already ran" flag, so the first would silently switch the per-key one off.
 *
 * So the address is charged for FAILED authentications only, and checked
 * before the lookup. A genuine integrator is never limited by address — a
 * platform hosting many customers behind one egress IP keeps working — and an
 * address that has failed MAX_API_KEY_AUTH_FAILURES_PER_MINUTE times in the
 * window is refused with 429 for the rest of it, at the cost of one Redis GET.
 * What remains is a valid key over its own ceiling paying one lookup before its
 * 429: bounded, and attributable to an authenticated tenant. Floods spread
 * over many addresses are the edge's job (ADR 0002).
 *
 * Redis holds only counters here, and every error fails open (ADR 0002): an
 * outage must cost the limit, never a customer's call. The panel's budgets
 * per company (panel-budget.ts) spend through the same guard, on the same
 * fail-fast connection.
 */
const MAX_API_KEY_AUTH_FAILURES_PER_MINUTE = 30;

/** Fixed, so a refused caller that waits this long always finds it reset. */
const WINDOW_SECONDS = 60;

interface IntegrationRateGuard {
  /** Whether this address already spent its failed-authentication budget. */
  authFailuresBlocked(address: string): Promise<boolean>;
  recordAuthFailure(address: string): Promise<void>;
  /** One more call for this company, true while it is within `max` a minute. */
  allowBusiness(businessId: string, max: number): Promise<boolean>;
  /**
   * Spends `cost` units of a panel budget in this minute (plano-escala
   * F2-28, shared/integration/panel-budget.ts): the total after it and when
   * the minute ends. Null when Redis did not answer: the caller fails open.
   */
  spendPanelBudget(
    key: string,
    cost: number,
  ): Promise<{ total: number; resetInMs: number } | null>;
  /**
   * Spends `cost` more units of a minute's counter (plano-escala U-04: a
   * batch of N deliveries counts N calls): the total after it and when the
   * minute ends. Null when Redis did not answer: the caller fails open.
   */
  spendUnits(
    key: string,
    cost: number,
  ): Promise<{ total: number; resetInMs: number } | null>;
  /** The same spend on the company's minute (`allowBusiness`'s counter). */
  spendBusiness(
    businessId: string,
    cost: number,
  ): Promise<{ total: number; resetInMs: number } | null>;
}

const authFailureKey = (address: string): string =>
  `integration:auth-fail:${address}`;

const businessKey = (businessId: string): string =>
  `integration:business:${businessId}`;

function createIntegrationRateGuard(
  redis: Pick<Redis, "eval" | "get">,
): IntegrationRateGuard {
  return {
    async authFailuresBlocked(address) {
      try {
        const count = Number((await redis.get(authFailureKey(address))) ?? 0);

        return count >= MAX_API_KEY_AUTH_FAILURES_PER_MINUTE;
      } catch {
        return false;
      }
    },

    async recordAuthFailure(address) {
      try {
        await countInFixedWindow(
          redis,
          authFailureKey(address),
          WINDOW_SECONDS,
        );
      } catch {
        // Fail open: the refusal itself still goes out.
      }
    },

    async spendPanelBudget(key, cost) {
      try {
        return await spendInFixedWindow(redis, key, WINDOW_SECONDS, cost);
      } catch {
        return null;
      }
    },

    async spendUnits(key, cost) {
      try {
        return await spendInFixedWindow(redis, key, WINDOW_SECONDS, cost);
      } catch {
        return null;
      }
    },

    async spendBusiness(businessId, cost) {
      try {
        return await spendInFixedWindow(
          redis,
          businessKey(businessId),
          WINDOW_SECONDS,
          cost,
        );
      } catch {
        return null;
      }
    },

    async allowBusiness(businessId, max) {
      try {
        return (
          (await countInFixedWindow(
            redis,
            businessKey(businessId),
            WINDOW_SECONDS,
          )) <= max
        );
      } catch {
        return true;
      }
    },
  };
}

/** For paths with no Redis (tests, scripts): never refuses, counts nothing. */
const unlimitedIntegrationRateGuard: IntegrationRateGuard = {
  authFailuresBlocked: async () => false,
  recordAuthFailure: async () => undefined,
  allowBusiness: async () => true,
  spendPanelBudget: async () => null,
  spendUnits: async () => null,
  spendBusiness: async () => null,
};

// Wired in http.ts with the rate-limit Redis connection.
let integrationRateGuard: IntegrationRateGuard = unlimitedIntegrationRateGuard;

function configureIntegrationRateGuard(guard: IntegrationRateGuard): void {
  integrationRateGuard = guard;
}

export {
  MAX_API_KEY_AUTH_FAILURES_PER_MINUTE,
  WINDOW_SECONDS as API_KEY_AUTH_FAILURE_WINDOW_SECONDS,
  WINDOW_SECONDS as INTEGRATION_RATE_WINDOW_SECONDS,
  configureIntegrationRateGuard,
  createIntegrationRateGuard,
  integrationRateGuard,
  unlimitedIntegrationRateGuard,
  type IntegrationRateGuard,
};
