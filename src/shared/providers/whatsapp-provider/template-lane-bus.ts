import { env } from "@/env";
import { consumesQueue } from "@/shared/lifecycle/process-role";
import { logger } from "@/shared/logging/logger";
import { publisher, subscribe } from "@/shared/redis/pubsub-redis";
import { MESSAGE_VERSIONS } from "@/shared/socket/messages";
import { selfReplica } from "@/shared/wake/wake-bus";

import {
  applyWhatsAppTemplateLaneChange,
  type TemplateLaneChange,
} from "./template-lane";

const log = logger.child({ component: "whatsapp-template-lane-bus" });

/**
 * The WhatsApp template lane between processes, on a channel of its own
 * (plano-escala U-07, F4.9).
 *
 * Meta's callback that pauses (or reinstates) a template lands on the HTTP
 * process; the senders that must stop are in the processes that drain the
 * `external` queue. It crossed as a `serverSideEmit` of the Socket.IO
 * adapter (websocket.ts), which every process heard because every process
 * subscribed to the adapter. A process that takes no sockets emits through
 * the Redis emitter (emitter.ts) and subscribes to nothing of the adapter,
 * so it would hear of a pause only from its first refused send. So the
 * change also goes, in the mold of the wake (wake-bus.ts), to
 * `<SOCKET_ADAPTER_KEY>:lane`:
 *
 *  - outside the adapter's patterns (`<key>#…`, `<key>-request#…`,
 *    `<key>-response#…`), so no socket ever receives it;
 *  - published by whoever applied the change, and heard by the processes
 *    that drain `external` without the adapter (SOCKETS_ENABLED=false): a
 *    process with the adapter still hears the adapter's frame, which stays
 *    for it and for the image before during a rolling deploy, and never
 *    applies the same change twice;
 *  - the payload is the change, the publisher's replica (its own message is
 *    not applied again) and `v`, the message's version; validated on
 *    arrival like anything off Redis (template-lane.ts);
 *  - at-most-once, as the adapter's frame was: a process that misses it
 *    learns the pause from its own first refused send, as it always did.
 */

/**
 * The version of the message: a reader knows its shape by it
 * (shared/socket/messages.ts, plano-escala F3-31c).
 */
const LANE_MESSAGE_VERSION = MESSAGE_VERSIONS["template-lane-channel"];

interface LaneMessage {
  v: number;
  replica: string;
  change: TemplateLaneChange;
}

function laneChannel(key: string = env.SOCKET_ADAPTER_KEY): string {
  return `${key}:lane`;
}

/** A message as published, or null for anything else on the channel. */
function parseLaneMessage(
  raw: string,
): { v: number; replica: string; change: unknown } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LaneMessage>;

    // Any version from 1 up: the change inside is validated on its own,
    // and a newer process's message keeps the fields an older one reads.
    return typeof parsed?.v === "number" &&
      parsed.v >= 1 &&
      typeof parsed.replica === "string" &&
      typeof parsed.change === "object" &&
      parsed.change !== null
      ? { v: parsed.v, replica: parsed.replica, change: parsed.change }
      : null;
  } catch {
    return null;
  }
}

interface LaneBusDeps {
  publish: (channel: string, message: string) => Promise<unknown>;
  listen: (channel: string, handler: (message: string) => void) => () => void;
  apply: (change: unknown) => unknown;
  channel: () => string;
  replica: () => string;

  /** Whether this process hears the lane on this channel. */
  listens: () => boolean;
}

const runtimeDeps = (): LaneBusDeps => ({
  publish: (channel, message) => publisher().publish(channel, message),
  listen: subscribe,
  apply: applyWhatsAppTemplateLaneChange,
  channel: () => laneChannel(),
  replica: selfReplica,
  listens: () => !env.SOCKETS_ENABLED && consumesQueue(env, "external"),
});

/**
 * Tells the processes without the adapter about a change this one already
 * applied. Never throws: the caller is Meta's callback, and a lost message
 * costs one refused send.
 */
async function publishTemplateLaneChange(
  change: TemplateLaneChange,
  deps: LaneBusDeps = runtimeDeps(),
): Promise<void> {
  try {
    await deps.publish(
      deps.channel(),
      JSON.stringify({
        v: LANE_MESSAGE_VERSION,
        replica: deps.replica(),
        change,
      } satisfies LaneMessage),
    );
  } catch (error) {
    log.warn(
      { err: error, ...change },
      "the whatsapp template lane could not be published",
    );
  }
}

/** Starts listening where the lane is needed; the result stops it. */
function startTemplateLaneListener(
  deps: LaneBusDeps = runtimeDeps(),
): () => void {
  if (!deps.listens()) return () => undefined;

  return deps.listen(deps.channel(), (raw) => {
    const message = parseLaneMessage(raw);

    if (!message || message.replica === deps.replica()) return;

    deps.apply(message.change);
  });
}

export {
  LANE_MESSAGE_VERSION,
  laneChannel,
  parseLaneMessage,
  publishTemplateLaneChange,
  startTemplateLaneListener,
};
export type { LaneBusDeps, LaneMessage };
