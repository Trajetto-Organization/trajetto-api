import { container } from "tsyringe";

import { logger } from "@/shared/logging/logger";

import type { IWhatsAppProvider } from "./IWhatsApp-provider";
import type { MetaTemplateUpdate } from "./meta-webhook";
import {
  TEMPLATE_LANGUAGE,
  TEMPLATE_PAUSE_RETRY_SECONDS,
} from "./implementations/meta-cloud-api-provider";

const log = logger.child({ component: "whatsapp-template-lane" });

/**
 * Meta's template status webhook, turned into the provider's lane pause
 * (OUTBOX-07 d, OUTBOX-16).
 *
 * The provider already stops calling Meta for a paused template — but it
 * learned the pause only from a send Meta refused (132015): each replica paid
 * one refusal on the account's record, and one attempt of a delivery, for
 * something Meta had announced on the webhook, which only logged it. Nothing
 * lifted the pause early either: after a reinstatement the backlog still
 * waited out the hour.
 *
 * The callback reaches ONE replica. It applies the change to its own provider
 * and announces it to the others through the Socket.IO adapter, the same
 * at-most-once channel refreshDeliveryRooms uses (ADR 0002). A replica that
 * misses it — Redis down, started later — is where it was before: it learns
 * the pause from its first refused send.
 */
type TemplateLaneChange =
  | { template: string; action: "pause"; seconds: number }
  | { template: string; action: "resume" };

/**
 * How long Meta pauses a template, by the `other_info.title` of the PAUSED
 * callback: 3 hours the first time, 6 the second (a third strike disables
 * it). Held that long, the lane never probes a pause Meta said is running.
 */
const META_PAUSE_SECONDS: Record<string, number> = {
  FIRST_PAUSE: 3 * 3600,
  SECOND_PAUSE: 6 * 3600,
};

/**
 * PAUSED with no known length, and DISABLED, hold for the same hour a refused
 * send does. For DISABLED that is an hour without refusals; the first send
 * after it meets 132016 and fails for good, as before, with the lane-stopped
 * error in the log — unless Meta approved the template again meanwhile.
 */
const PAUSING_EVENTS = new Set(["PAUSED", "DISABLED"]);
const RESUMING_EVENTS = new Set(["REINSTATED", "APPROVED"]);

/**
 * Longest hold a change may carry. Above Meta's longest pause, and bounded:
 * a change announced by another replica is checked like any input, and none
 * may freeze a lane for days.
 */
const MAX_PAUSE_SECONDS = 24 * 3600;

const MAX_TEMPLATE_NAME_LENGTH = 512;

/**
 * What each callback asks of the lane. A pause counts from when Meta says it
 * happened, not from when the callback arrived: Meta redelivers for days a
 * callback that did not get a 200, and a PAUSED landing after its pause was
 * over — possibly after the REINSTATED that ended it — must not stop the
 * lane again. A resume is always applied: lifting a pause early costs at
 * most one refused send, which puts it back.
 */
function templateLaneChanges(
  updates: MetaTemplateUpdate[],
  now: Date = new Date(),
): TemplateLaneChange[] {
  const changes: TemplateLaneChange[] = [];

  for (const update of updates) {
    if (!update.templateName) continue;

    // A template is a name AND a language; ours are all pt_BR. An older
    // callback without the language still names ours.
    if (update.language && update.language !== TEMPLATE_LANGUAGE) continue;

    if (PAUSING_EVENTS.has(update.event)) {
      const pause =
        (update.event === "PAUSED" && update.pauseTitle
          ? META_PAUSE_SECONDS[update.pauseTitle]
          : undefined) ?? TEMPLATE_PAUSE_RETRY_SECONDS;

      // Never negative: a clock ahead of ours does not lengthen the pause.
      const elapsed = update.occurredAt
        ? Math.max(0, (now.getTime() - update.occurredAt.getTime()) / 1000)
        : 0;

      const seconds = Math.ceil(pause - elapsed);

      if (seconds <= 0) continue;

      changes.push({ template: update.templateName, action: "pause", seconds });
    } else if (RESUMING_EVENTS.has(update.event)) {
      changes.push({ template: update.templateName, action: "resume" });
    }
  }

  return changes;
}

function isTemplateLaneChange(value: unknown): value is TemplateLaneChange {
  if (typeof value !== "object" || value === null) return false;

  const { template, action, seconds } = value as Record<string, unknown>;

  if (
    typeof template !== "string" ||
    template.length === 0 ||
    template.length > MAX_TEMPLATE_NAME_LENGTH
  ) {
    return false;
  }

  if (action === "resume") return true;

  return (
    action === "pause" &&
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= MAX_PAUSE_SECONDS
  );
}

/**
 * Applies a change to this replica's WhatsApp provider. Takes `unknown`
 * because the same function receives what another replica announced. Never
 * throws: a lane change is an optimisation, and the callback that carried it
 * must still record its statuses.
 */
function applyWhatsAppTemplateLaneChange(change: unknown): boolean {
  if (!isTemplateLaneChange(change)) {
    log.warn("malformed whatsapp template lane change ignored");
    return false;
  }

  try {
    const provider = container.resolve<IWhatsAppProvider>("WhatsAppProvider");

    if (change.action === "pause") {
      if (!provider.pauseTemplate) return false;

      provider.pauseTemplate(change.template, change.seconds);
    } else {
      if (!provider.resumeTemplate) return false;

      provider.resumeTemplate(change.template);
    }

    log.info(change, "whatsapp template lane changed");

    return true;
  } catch (error) {
    log.error({ err: error, ...change }, "whatsapp template lane change not applied");
    return false;
  }
}

export {
  MAX_PAUSE_SECONDS,
  META_PAUSE_SECONDS,
  applyWhatsAppTemplateLaneChange,
  templateLaneChanges,
};
export type { TemplateLaneChange };
