import { NotificationChannel } from "@prisma/client";

/**
 * The pipeline's decision rules, kept pure so they can be unit-tested.
 * Timings and gating live here; I/O lives in the pipeline service.
 */

/**
 * How long a claimed OUTBOX row stays invisible to other replicas.
 *
 * Expansion is database-only work (read the policy, insert delivery rows),
 * so a minute is already generous — and a short lease is what makes a
 * replica that died mid-expansion recover fast.
 */
const OUTBOX_LEASE_SECONDS = 60;

/**
 * How long a claimed DELIVERY row stays invisible to other replicas.
 *
 * Deliveries call the outside world (SMTP, Meta, Expo), so the lease has to
 * outlast the slowest possible batch — otherwise a second replica reclaims
 * rows the first one is still sending, and the recipient gets the message
 * twice. WhatsApp and e-mail have no natural dedupe on the provider side,
 * so this is a correctness bound, not a tuning knob.
 */
const DELIVERY_LEASE_SECONDS = 180;

/** How many deliveries of one batch run at the same time. */
const DELIVERY_CONCURRENCY = 5;

/**
 * Hard ceiling for a single delivery. The providers set their own request
 * timeouts; this is the backstop for anything that hangs before or after the
 * call (a stuck DNS lookup, a provider SDK that ignores its own timeout).
 */
const PER_DELIVERY_TIMEOUT_MS = 15_000;

/**
 * The invariant that keeps a batch inside its lease:
 *
 *   ceil(batch / concurrency) * timeout  <  lease
 *
 * With 20 / 5 / 15s that is 4 waves of 15s = 60s against a 180s lease — a
 * 3x margin. Asserted at load time so raising the batch size (or the
 * timeout) without raising the lease fails loudly here instead of silently
 * duplicating messages in production.
 */
function assertDeliveryLeaseInvariant(
  batchSize: number,
  concurrency: number = DELIVERY_CONCURRENCY,
  timeoutMs: number = PER_DELIVERY_TIMEOUT_MS,
  leaseSeconds: number = DELIVERY_LEASE_SECONDS,
): void {
  const worstCaseMs = Math.ceil(batchSize / concurrency) * timeoutMs;

  if (worstCaseMs >= leaseSeconds * 1000) {
    throw new Error(
      `Delivery lease invariant violated: a batch of ${batchSize} at ` +
        `concurrency ${concurrency} can take ${worstCaseMs}ms, which does ` +
        `not fit in the ${leaseSeconds}s lease. Raise the lease or lower ` +
        `the batch/timeout.`,
    );
  }
}

/** Backoff between attempts; length also defines the maximum attempts. */
const OUTBOX_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

/**
 * Deliveries get a longer tail than expansion: expansion only needs our own
 * database, while a delivery waits on somebody else's provider. The schedule
 * used to end at ~42 minutes, so an hour-long e-mail or WhatsApp outage turned
 * every message of its first twenty minutes into a permanent failure that
 * nothing replayed. It now spans ~4h40 — past a long provider incident.
 */
const DELIVERY_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
];

/**
 * The most times a row is ever claimed: the retry schedule, plus the attempt
 * before it. Also the ceiling on RECLAIMS — a row whose attempt died with the
 * process is claimed again when its lease runs out, and before this ceiling it
 * was claimed again forever: a row that kills its worker would take every
 * replica down in turn.
 */
const OUTBOX_MAX_ATTEMPTS = OUTBOX_RETRY_DELAYS_MS.length + 1;
const DELIVERY_MAX_ATTEMPTS = DELIVERY_RETRY_DELAYS_MS.length + 1;

/**
 * A provider asking us to come back later is honoured, within reason: never
 * sooner than our own backoff, never later than an hour.
 */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

function honourRetryAfter(
  backoffMs: number,
  retryAfterMs: number | undefined,
): number {
  if (!retryAfterMs || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return backoffMs;
  }

  return Math.max(backoffMs, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

/**
 * How long an event whose topic this build does not know is kept waiting for
 * a build that does.
 *
 * During a rolling deploy the OLD replicas keep claiming work, including
 * events published by the new version under topics the old code has never
 * heard of — and those used to be marked FAILED on the spot, for good. A
 * rollback did the same to every such event still pending. The row is now put
 * back untouched for a newer replica to take; only after a day is it given up
 * on, which is when "unknown topic" stops meaning "deploy in progress".
 */
const UNKNOWN_TOPIC_PATIENCE_MS = 24 * 60 * 60_000;
const UNKNOWN_TOPIC_RECHECK_MS = 60_000;

/**
 * Deliveries run in two lanes, each with its own claim and its own workers.
 *
 * One FIFO used to serve every channel of every tenant: a slow or hung e-mail
 * or WhatsApp provider held the five delivery slots, and the in-app bell, the
 * phone push and the chat of every company waited behind it. The internal
 * lane touches only our own database and Expo; the external lane is where
 * third-party latency lives, and it can no longer starve the other.
 */
const DELIVERY_LANES = {
  internal: ["IN_APP", "ACTIVITY", "PUSH"],
  external: ["EMAIL", "WHATSAPP"],
} as const satisfies Record<string, readonly NotificationChannel[]>;

type DeliveryLane = keyof typeof DELIVERY_LANES;

function laneOf(channel: NotificationChannel): DeliveryLane {
  return (DELIVERY_LANES.external as readonly string[]).includes(channel)
    ? "external"
    : "internal";
}

/**
 * Delay before the next try, or null when the attempts are exhausted and the
 * row should be marked FAILED. `attempts` is the count already spent,
 * including the one that just failed.
 */
function nextRetryDelayMs(
  attempts: number,
  delays: number[] = DELIVERY_RETRY_DELAYS_MS,
): number | null {
  if (attempts > delays.length) return null;

  return delays[attempts - 1];
}

interface RecipientChannelFlags {
  activityNotificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  whatsappNotificationsEnabled: boolean;
  hasWhatsAppPhone: boolean;
}

interface RecipientLegacyToggles {
  activity_notifications_enabled?: boolean;
  email_notifications_enabled?: boolean;
  whatsapp_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;
}

interface CategoryPreference {
  inApp: boolean;
  email: boolean;
  whatsapp: boolean;
}

/**
 * Layers a per-category preference over the legacy global toggles.
 *
 * No preference row = no opinion: the user's old global switches keep
 * deciding, which is what makes shipping preferences change nobody's
 * behavior until they actually touch the new screen. A row, once saved,
 * overrides the globals for its category — except that WhatsApp still
 * requires a configured phone, which no preference can conjure.
 */
function resolveRecipientChannelFlags(
  recipient: RecipientLegacyToggles,
  preference: CategoryPreference | undefined,
): RecipientChannelFlags {
  return {
    activityNotificationsEnabled: preference
      ? preference.inApp
      : (recipient.activity_notifications_enabled ?? true),
    emailNotificationsEnabled: preference
      ? preference.email
      : (recipient.email_notifications_enabled ?? true),
    whatsappNotificationsEnabled: preference
      ? preference.whatsapp
      : (recipient.whatsapp_notifications_enabled ?? false),
    hasWhatsAppPhone: Boolean(recipient.whatsapp_phone),
  };
}

/**
 * Which channels a recipient gets for an event, honoring the same per-user
 * toggles the old inline flow honored. Category-level preferences
 * (NotificationPreference) will replace these flags in a later slice.
 */
function channelsForRecipient(
  flags: RecipientChannelFlags,
  options: {
    hasInAppContent: boolean;

    /** E-mail reuses the in-app render, so this implies in-app content too. */
    hasEmailContent: boolean;
    hasWhatsAppContent: boolean;

    /** Mandatory topics deliver in-app whatever the preferences say. */
    isMandatory?: boolean;

    /**
     * Whether this recipient has a registered mobile device. Push is the
     * phone-shaped form of in-app: it follows the in-app decision (same
     * content, same preference) and only exists where a device does —
     * users who never installed the app get no dead PUSH rows.
     */
    hasPushDevice?: boolean;

    /**
     * Push-only topics (chat): the content exists solely as a tray push,
     * with no in-app notification row. Gated by the same in-app preference
     * (or the mandatory override), because push is the in-app channel in
     * the phone's shape — there is no separate "push" toggle to honor.
     */
    hasStandalonePushContent?: boolean;
  },
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  const inAppAllowed =
    flags.activityNotificationsEnabled || Boolean(options.isMandatory);

  const wantsInApp = options.hasInAppContent && inAppAllowed;

  if (wantsInApp) {
    channels.push(NotificationChannel.IN_APP);
  }

  const wantsPush =
    (wantsInApp || (Boolean(options.hasStandalonePushContent) && inAppAllowed)) &&
    Boolean(options.hasPushDevice);

  if (wantsPush) {
    channels.push(NotificationChannel.PUSH);
  }

  if (options.hasEmailContent && flags.emailNotificationsEnabled) {
    channels.push(NotificationChannel.EMAIL);
  }

  if (
    options.hasWhatsAppContent &&
    flags.whatsappNotificationsEnabled &&
    flags.hasWhatsAppPhone
  ) {
    channels.push(NotificationChannel.WHATSAPP);
  }

  return channels;
}

/**
 * Spreads a retry over a window instead of firing the whole failed batch at
 * the same instant. A provider that just rate-limited us would otherwise get
 * the identical burst back 30s later, fail again, and keep the pattern —
 * every replica in lockstep. +/-20% is enough to break the convoy without
 * making the backoff schedule unpredictable to reason about.
 */
function withRetryJitter(delayMs: number): number {
  const spread = delayMs * 0.2;
  const offset = (Math.random() * 2 - 1) * spread;

  return Math.max(1_000, Math.round(delayMs + offset));
}

export {
  DELIVERY_LANES,
  DELIVERY_MAX_ATTEMPTS,
  OUTBOX_MAX_ATTEMPTS,
  UNKNOWN_TOPIC_PATIENCE_MS,
  UNKNOWN_TOPIC_RECHECK_MS,
  honourRetryAfter,
  laneOf,
  OUTBOX_LEASE_SECONDS,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_CONCURRENCY,
  PER_DELIVERY_TIMEOUT_MS,
  assertDeliveryLeaseInvariant,
  OUTBOX_RETRY_DELAYS_MS,
  DELIVERY_RETRY_DELAYS_MS,
  nextRetryDelayMs,
  withRetryJitter,
  channelsForRecipient,
  resolveRecipientChannelFlags,
};

export type {
  CategoryPreference,
  DeliveryLane,
  RecipientChannelFlags,
  RecipientLegacyToggles,
};
