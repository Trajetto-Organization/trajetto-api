import { Emitter } from "@socket.io/redis-emitter";
import type Redis from "ioredis";

import { emitterClient } from "@/shared/redis/pubsub-redis";
import { socketAdapterOptions } from "@/shared/socket/adapter-redis";

/**
 * How a process that takes no sockets reaches the sockets of the cluster
 * (plano-escala U-07, F4.9).
 *
 * Every process used to install the Socket.IO server with the Redis
 * adapter, the worker and the scheduler included (F3-02), so that what
 * they emit reaches the sockets on the api. The adapter's subscriber
 * PSUBSCRIBEs to every frame of the namespace: every position, every chat
 * message and every notification nudge the cluster publishes was sent by
 * Redis to each of those processes too, which had no socket to hand it
 * to. At the plan's scale that copy per subscriber is the first thing the
 * Redis runs out of (its output bandwidth, `total_net_output_bytes`).
 *
 * With SOCKETS_ENABLED=false the process emits through
 * @socket.io/redis-emitter instead, on one publish-only connection of the
 * pub/sub factory (pubsub-redis.ts): the same frames, on the same channels
 * (`<SOCKET_ADAPTER_KEY>#/#…`), in the format the adapter of the version
 * pinned beside it reads, and nothing subscribed. It covers what such a
 * process sends: emits to rooms (volatile included), the revocations by
 * room (`disconnectSockets`, a REMOTE_DISCONNECT the adapters act on) and
 * the server-side events (`serverSideEmit`). What it can no longer do is
 * hear a `serverSideEmit`: the WhatsApp template lane, the one such event
 * a worker needs, has its own channel (template-lane-bus.ts). With
 * SOCKETS_ENABLED=true (the `all` role of today) nothing of this runs.
 */

/** The two calls of a room target both Socket.IO and the emitter share. */
interface RoomTarget {
  to(room: string | string[]): RoomTarget;
  emit(event: string, ...args: unknown[]): boolean;
  readonly volatile: RoomTarget;
  disconnectSockets(close?: boolean): void;
}

/** What the emit helpers of websocket.ts need from either. */
interface Broadcaster {
  to(room: string | string[]): RoomTarget;
  in(room: string | string[]): RoomTarget;
  serverSideEmit(event: string, ...args: unknown[]): unknown;
}

interface SocketEmitter {
  broadcaster: Broadcaster;
  client: Redis;
}

/**
 * The emitter on the factory's connection, with the adapter's channel
 * prefix: the key is the only isolation between stacks sharing a Redis,
 * and a different one would reach nobody.
 */
function createSocketEmitter(
  env: { SOCKET_ADAPTER_KEY?: string },
  onPublishFailure: (error: unknown) => void,
): SocketEmitter {
  const client = emitterClient(onPublishFailure);
  const emitter = new Emitter(client, { key: socketAdapterOptions(env).key });

  return { broadcaster: emitter as unknown as Broadcaster, client };
}

export { createSocketEmitter };
export type { Broadcaster, RoomTarget, SocketEmitter };
