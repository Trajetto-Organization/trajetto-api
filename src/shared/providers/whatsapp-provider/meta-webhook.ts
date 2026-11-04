import { createHmac, timingSafeEqual } from "node:crypto";

import { CUSTOMER_WHATSAPP_TEMPLATES } from "@/shared/delivery/customer-whatsapp-templates";
import { INTERNAL_WHATSAPP_TEMPLATES } from "@/shared/notifications/whatsapp-templates";

/**
 * Reading what Meta posts to the status webhook. Pure, so the parts that
 * decide whether a body is trusted and what it says can be proven without a
 * server.
 *
 * Shape: developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 * — `entry[].changes[]` with `field: "messages"` carrying `value.statuses[]`,
 * `field: "message_template_status_update"` carrying a template's new
 * state (APPROVED, PAUSED, DISABLED...), and `field: "template_category_update"`
 * carrying a recategorization (plan of 02/11/2026, B7).
 */

/** One status Meta reported for one message. */
interface MetaStatusReport {
  /** The wamid. */
  providerMessageId: string;

  /** sent | delivered | read | failed, verbatim. */
  status: string;

  occurredAt: Date;

  /** What we sent as biz_opaque_callback_data: the delivery id, when UUID-shaped. */
  deliveryId: string | null;

  errorCode: string | null;
  errorMessage: string | null;
}

interface MetaTemplateUpdate {
  event: string;
  templateName: string | null;
  reason: string | null;

  /** A template is a name AND a language; we only ever send pt_BR. */
  language: string | null;

  /** `other_info.title` of a pause: FIRST_PAUSE (3 h), SECOND_PAUSE (6 h)... */
  pauseTitle: string | null;

  /**
   * The entry's `time`: when Meta says it happened. A callback Meta
   * redelivers after an outage on our side can arrive hours later.
   */
  occurredAt: Date | null;
}

/**
 * Meta moved a template to another category (UTILITY → MARKETING, say). It
 * announces it a day ahead (`correct_category`) and when it happens
 * (`new_category`, with `previous_category`).
 */
interface MetaCategoryUpdate {
  templateName: string | null;
  language: string | null;
  previousCategory: string | null;
  newCategory: string | null;

  /** The notice a day ahead, not the change itself. */
  announced: boolean;

  occurredAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns are text, but a callback is untrusted input until proven otherwise. */
const MAX_FIELD_LENGTH = 500;

/**
 * Whether `header` is Meta's signature of these exact bytes.
 *
 * Meta signs the RAW body with the App Secret (HMAC-SHA256, hex, prefixed
 * `sha256=`). Anything re-serialised — a parsed and re-stringified object —
 * has different bytes, which is why the route keeps the body as a Buffer.
 * Constant-time: the comparison must not tell a prober how many leading
 * characters of a forged signature were right.
 */
function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;

  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();

  // Buffer.from(hex) drops what is not hex, so a malformed header comes out
  // short; timingSafeEqual would throw on the length mismatch.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/** The subscription handshake's token check, constant-time. */
function isMetaVerifyTokenValid(
  received: string | undefined,
  expected: string,
): boolean {
  if (typeof received !== "string") return false;

  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value.slice(0, MAX_FIELD_LENGTH);
  }

  if (typeof value === "number" && Number.isFinite(value)) return String(value);

  return null;
}

function changesOf(body: unknown): Array<{ field?: unknown; value?: unknown }> {
  const entries = (body as { entry?: unknown })?.entry;

  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    const changes = (entry as { changes?: unknown })?.changes;

    return Array.isArray(changes)
      ? (changes as Array<{ field?: unknown; value?: unknown }>)
      : [];
  });
}

/**
 * Every message status in a callback body. Anything malformed is skipped
 * rather than refused: Meta retries a non-200 for days, and one odd entry
 * must not hold back the valid ones next to it.
 */
function extractMetaStatuses(body: unknown): MetaStatusReport[] {
  const reports: MetaStatusReport[] = [];

  for (const change of changesOf(body)) {
    if (change.field !== "messages") continue;

    const statuses = (change.value as { statuses?: unknown })?.statuses;

    if (!Array.isArray(statuses)) continue;

    for (const raw of statuses as Array<Record<string, unknown>>) {
      const providerMessageId = text(raw?.id);
      const status = text(raw?.status);

      if (!providerMessageId || !status) continue;

      const seconds = Number(raw.timestamp);

      const callbackData = text(raw.biz_opaque_callback_data);

      const [firstError] = Array.isArray(raw.errors)
        ? (raw.errors as Array<Record<string, unknown>>)
        : [];

      const details = (firstError?.error_data as { details?: unknown })
        ?.details;

      reports.push({
        providerMessageId,
        status: status.toLowerCase(),
        occurredAt:
          Number.isFinite(seconds) && seconds > 0
            ? new Date(seconds * 1000)
            : new Date(),
        deliveryId:
          callbackData && UUID.test(callbackData)
            ? callbackData.toLowerCase()
            : null,
        errorCode: text(firstError?.code),
        errorMessage:
          text(details) ?? text(firstError?.message) ?? text(firstError?.title),
      });
    }
  }

  return reports;
}

/**
 * Template state changes (PAUSED, DISABLED, REINSTATED, APPROVED...): logged,
 * and turned into the lane's pause by template-lane.ts.
 */
function extractMetaTemplateUpdates(body: unknown): MetaTemplateUpdate[] {
  const entries = (body as { entry?: unknown })?.entry;

  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    const seconds = Number((entry as { time?: unknown })?.time);
    const occurredAt =
      Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;

    return changesOf({ entry: [entry] })
      .filter((change) => change.field === "message_template_status_update")
      .map((change) => {
        const value = (change.value ?? {}) as Record<string, unknown>;
        const otherInfo = (value.other_info ?? {}) as Record<string, unknown>;

        return {
          event: text(value.event) ?? "UNKNOWN",
          templateName: text(value.message_template_name),
          reason: text(value.reason),
          language: text(value.message_template_language),
          pauseTitle: text(otherInfo?.title),
          occurredAt,
        };
      });
  });
}

/**
 * Recategorizations in a callback body (plan of 02/11/2026, B7). Anything
 * malformed is skipped, like the other readers here.
 */
function extractMetaCategoryUpdates(body: unknown): MetaCategoryUpdate[] {
  const entries = (body as { entry?: unknown })?.entry;

  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    const seconds = Number((entry as { time?: unknown })?.time);
    const occurredAt =
      Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;

    return changesOf({ entry: [entry] })
      .filter((change) => change.field === "template_category_update")
      .map((change) => {
        const value = (change.value ?? {}) as Record<string, unknown>;
        const newCategory = text(value.new_category);
        const correctCategory = text(value.correct_category);

        return {
          templateName: text(value.message_template_name),
          language: text(value.message_template_language),
          previousCategory: text(value.previous_category),
          newCategory: (newCategory ?? correctCategory)?.toUpperCase() ?? null,
          announced: !newCategory && Boolean(correctCategory),
          occurredAt,
        };
      });
  });
}

/** Every template name the code sends, internal and customer. */
const OUR_TEMPLATES = new Set<string>([
  ...Object.values(INTERNAL_WHATSAPP_TEMPLATES).map((t) => t.name),
  ...Object.values(CUSTOMER_WHATSAPP_TEMPLATES).map((t) => t.name),
]);

/**
 * The updates that must raise an alarm: one of OUR templates, in our
 * language (pt_BR, or a callback without one), leaving UTILITY. A template
 * of the account the code never sends is somebody else's business.
 */
function templateCategoryAlarms(
  updates: MetaCategoryUpdate[],
): MetaCategoryUpdate[] {
  return updates.filter(
    (update) =>
      update.templateName !== null &&
      OUR_TEMPLATES.has(update.templateName) &&
      (!update.language || update.language === "pt_BR") &&
      update.newCategory !== null &&
      update.newCategory !== "UTILITY",
  );
}

/**
 * How far along a message is, as Meta reports it. A status only ever replaces
 * a lower one: callbacks arrive out of order, and a late 'sent' must not undo
 * a 'read'. 'failed' is final.
 */
const META_STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export {
  META_STATUS_RANK,
  extractMetaCategoryUpdates,
  extractMetaStatuses,
  extractMetaTemplateUpdates,
  isMetaVerifyTokenValid,
  templateCategoryAlarms,
  verifyMetaSignature,
};

export type { MetaCategoryUpdate, MetaStatusReport, MetaTemplateUpdate };
