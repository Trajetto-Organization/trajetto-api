import { NotificationChannel } from "@prisma/client";

import {
  channelsForRecipient,
  type RecipientChannelFlags,
} from "./pipeline-rules";

/**
 * What a delivery can say about itself beyond DELIVERED/FAILED (OBS-08). Pure,
 * so the format other code keys on — the dead letter, the alerting job — is
 * pinned by tests.
 */

type DeliveryProvider = "whatsapp" | "email" | "push";

/**
 * The provider's own words about a refusal, as far as they are codes.
 *
 * The pipeline used to keep only the sentence. Meta's HTTP status and error
 * code, nodemailer's code and the SMTP reply were dropped on the way to
 * lastError — and they are exactly what tells an expired token (190, EAUTH)
 * from a number without WhatsApp (131026) or a full mailbox (452).
 */
interface ProviderErrorDetail {
  provider: DeliveryProvider;

  /** HTTP status the provider's API answered with (Meta Graph, Expo). */
  httpStatus?: number;

  /** Meta Cloud API error code. */
  errorCode?: number | string;

  /** Nodemailer's code for the transport failure (EAUTH, ETIMEDOUT...). */
  smtpCode?: string;

  /** The SMTP server's numeric reply (535, 550, 451...). */
  smtpReply?: number;
}

/**
 * A field of the prefix, cut to what a code can contain: a provider's text
 * must never be able to close the bracket and forge another field.
 */
function token(value: string | number): string {
  return String(value)
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 32);
}

/**
 * `[whatsapp http=401 code=190] Session has expired`.
 *
 * The bracket is machine-readable on purpose: isCredentialFailure (and the
 * ops alerting) key on it, and support can search the dead letter for
 * `code=131026` instead of guessing Meta's wording. A failure that never
 * reached a provider (recipient deleted, no template) has no detail and is
 * stored as it was.
 */
function formatDeliveryError(
  message: string,
  detail?: ProviderErrorDetail,
): string {
  if (!detail) return message;

  const fields = [
    detail.httpStatus !== undefined ? `http=${token(detail.httpStatus)}` : null,
    detail.errorCode !== undefined ? `code=${token(detail.errorCode)}` : null,
    detail.smtpCode ? `smtp=${token(detail.smtpCode)}` : null,
    detail.smtpReply !== undefined ? `reply=${token(detail.smtpReply)}` : null,
  ].filter((field): field is string => field !== null);

  return `[${[detail.provider, ...fields].join(" ")}] ${message}`;
}

const PROVIDERS: readonly string[] = ["whatsapp", "email", "push"];

function isDetail(value: unknown): value is ProviderErrorDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    PROVIDERS.includes((value as { provider?: unknown }).provider as string)
  );
}

/**
 * The detail a thrown error carries: the pipeline's own delivery errors
 * attach one; the Expo sender throws a plain Error with the HTTP status on
 * it, which only means something on a push.
 */
function providerDetailOf(
  error: unknown,
  channel?: NotificationChannel,
): ProviderErrorDetail | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const { detail, httpStatus } = error as {
    detail?: unknown;
    httpStatus?: unknown;
  };

  if (isDetail(detail)) return detail;

  if (channel === NotificationChannel.PUSH && typeof httpStatus === "number") {
    return { provider: "push", httpStatus };
  }

  return undefined;
}

/**
 * The failures an operator must hear about on the FIRST occurrence: the
 * credential or the configuration is wrong, so every later send of that
 * channel fails the same way until somebody changes it.
 *
 *  - Meta: HTTP 401/403, or error 190 (access token expired/invalidated);
 *    or the provider reporting itself unconfigured;
 *  - SMTP: EAUTH, or the server's 530/535 (authentication required/failed);
 *  - Expo: HTTP 401/403 (the push access token).
 *
 * Only the bracket is read — a provider's free text that happens to quote a
 * status is not evidence.
 */
function isCredentialFailure(lastError: string | null | undefined): boolean {
  if (!lastError) return false;

  const prefix =
    /^\[(whatsapp|email|push)((?: [a-z]+=[A-Za-z0-9._-]+)*)\]/.exec(lastError);

  if (!prefix) return false;

  const [, provider, rawFields] = prefix;
  const fields = new Map(
    rawFields
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((field) => field.split("=") as [string, string]),
  );

  const http = fields.get("http");

  switch (provider) {
    case "whatsapp":
      return (
        http === "401" ||
        http === "403" ||
        fields.get("code") === "190" ||
        /WhatsApp não configurado/.test(lastError)
      );
    case "email":
      return (
        fields.get("smtp") === "EAUTH" ||
        fields.get("reply") === "535" ||
        fields.get("reply") === "530"
      );
    case "push":
      return http === "401" || http === "403";
    default:
      return false;
  }
}

type SuppressionReason = "preference_off" | "no_push_device" | "no_contact";

/**
 * The channels a topic has content for that a recipient did NOT get, and why.
 *
 * Expansion decides the channels and creates only those rows, so "she never
 * gets WhatsApp" left nothing to look at: no row, no log. This is the other
 * half of channelsForRecipient's decision, for a debug line.
 */
function suppressedChannels(
  flags: RecipientChannelFlags,
  options: Parameters<typeof channelsForRecipient>[1],
): Array<{ channel: NotificationChannel; reason: SuppressionReason }> {
  const chosen = new Set(channelsForRecipient(flags, options));

  const inAppAllowed =
    flags.activityNotificationsEnabled || Boolean(options.isMandatory);

  const suppressed: Array<{
    channel: NotificationChannel;
    reason: SuppressionReason;
  }> = [];

  if (options.hasInAppContent && !chosen.has(NotificationChannel.IN_APP)) {
    suppressed.push({
      channel: NotificationChannel.IN_APP,
      reason: "preference_off",
    });
  }

  const hasPushContent =
    options.hasInAppContent || Boolean(options.hasStandalonePushContent);

  if (hasPushContent && !chosen.has(NotificationChannel.PUSH)) {
    suppressed.push({
      channel: NotificationChannel.PUSH,
      reason: inAppAllowed ? "no_push_device" : "preference_off",
    });
  }

  if (options.hasEmailContent && !chosen.has(NotificationChannel.EMAIL)) {
    suppressed.push({
      channel: NotificationChannel.EMAIL,
      reason: "preference_off",
    });
  }

  if (options.hasWhatsAppContent && !chosen.has(NotificationChannel.WHATSAPP)) {
    suppressed.push({
      channel: NotificationChannel.WHATSAPP,
      reason: flags.whatsappNotificationsEnabled
        ? "no_contact"
        : "preference_off",
    });
  }

  return suppressed;
}

export {
  formatDeliveryError,
  isCredentialFailure,
  providerDetailOf,
  suppressedChannels,
};
export type { DeliveryProvider, ProviderErrorDetail, SuppressionReason };
