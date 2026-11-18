import database from "@/../infra/database";
import { env } from "@/env";
import {
  ProviderQuotaRepository,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";
import {
  businessDateKey,
  businessDayStart,
  resolveTimeZone,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * The daily WhatsApp quota of each company (plano-escala F3-15b; decisions
 * D23 and D46).
 *
 * WhatsApp messages are sent through the platform's one WhatsApp Business
 * account: one carrier's burst spends the messaging tier and the quality
 * rating every other carrier depends on, and a block by Meta stops them
 * all. With WHATSAPP_DAILY_QUOTA_PER_TENANT above 0, a company sends at
 * most that many a day (its business day, in its own time zone): each call
 * to Meta takes one unit of provider_quota_day, provider "whatsapp", scope
 * "whatsapp:<businessId>", counted in Postgres so a Redis eviction can
 * neither lose nor reset it (the take is atomic across processes: 50
 * parallel takes with a limit of 10 grant exactly 10).
 *
 * The message past the quota is not lost and not spent: it waits, without
 * using one of its attempts, until the company's next business day, and
 * goes out then (subject to that day's quota). It never falls back to the
 * e-mail: the recipient chose WhatsApp, and an e-mail would be a second
 * channel nobody asked for. A call that fails at Meta still spent its unit:
 * the count is of calls, which is what the account is measured by.
 *
 * Off (0, the default) nothing is read nor written: the send of before.
 * Messages of no company (the platform's own) are never counted.
 */

const WHATSAPP_QUOTA_PROVIDER = "whatsapp";

/** The company's scope of the day's row. */
function whatsAppQuotaScope(businessId: string): string {
  return `${WHATSAPP_QUOTA_PROVIDER}:${businessId}`;
}

type WhatsAppQuotaVerdict =
  | { allowed: true }
  | {
      allowed: false;

      /** The company's business day the quota ran out on (YYYY-MM-DD). */
      day: string;

      /** The quota that ran out. */
      limit: number;

      /** When the company's next business day starts: the wait's end. */
      until: Date;
    };

interface WhatsAppDailyQuotaDeps {
  quota: IProviderQuotaRepository;

  /** The day's quota per company; 0 or less is no quota. */
  limit: () => number;

  /** The company's time zone (Business.timezone); null for the default. */
  timeZoneOf: (businessId: string) => Promise<string | null>;

  now?: () => Date;
}

function createWhatsAppDailyQuota(deps: WhatsAppDailyQuotaDeps) {
  return {
    /**
     * Takes one message of the company's day, or says until when it waits.
     * Throws when the count cannot be read or written: a send that cannot
     * be counted is not made (the delivery's retry handles it).
     */
    async take(businessId: string | null): Promise<WhatsAppQuotaVerdict> {
      const limit = Math.floor(deps.limit());

      if (!businessId || !Number.isFinite(limit) || limit <= 0) {
        return { allowed: true };
      }

      const now = deps.now?.() ?? new Date();
      const timeZone = resolveTimeZone(await deps.timeZoneOf(businessId));
      const day = businessDateKey(now, timeZone);

      const taken = await deps.quota.take(WHATSAPP_QUOTA_PROVIDER, day, [
        { scope: whatsAppQuotaScope(businessId), limit },
      ]);

      if (taken.granted) return { allowed: true };

      return {
        allowed: false,
        day,
        limit,
        until: businessDayStart(shiftDateKey(day, 1), timeZone),
      };
    },
  };
}

type WhatsAppDailyQuota = ReturnType<typeof createWhatsAppDailyQuota>;

/** The process's quota, on the runtime's database and env. */
const whatsAppDailyQuota = createWhatsAppDailyQuota({
  quota: new ProviderQuotaRepository(),
  limit: () => env.WHATSAPP_DAILY_QUOTA_PER_TENANT,
  timeZoneOf: async (businessId) =>
    (
      await database.business.findUnique({
        where: { id: businessId },
        select: { timezone: true },
      })
    )?.timezone ?? null,
});

export {
  WHATSAPP_QUOTA_PROVIDER,
  createWhatsAppDailyQuota,
  whatsAppDailyQuota,
  whatsAppQuotaScope,
};
export type {
  WhatsAppDailyQuota,
  WhatsAppDailyQuotaDeps,
  WhatsAppQuotaVerdict,
};
