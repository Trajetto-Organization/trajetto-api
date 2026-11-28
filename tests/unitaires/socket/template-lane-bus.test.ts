import { describe, expect, it, vi } from "vitest";

import {
  laneChannel,
  parseLaneMessage,
  publishTemplateLaneChange,
  startTemplateLaneListener,
  type LaneBusDeps,
} from "@/shared/providers/whatsapp-provider/template-lane-bus";

/**
 * The WhatsApp template lane on a channel of its own (plano-escala U-07).
 *
 * A process without sockets emits through the Redis emitter and no longer
 * hears the adapter's `serverSideEmit`, so the pause Meta announces to the
 * HTTP process would reach its senders only through the first refused
 * send. The lane's channel carries it to the processes that drain
 * `external` without the adapter, and to nobody else.
 */

function deps(overrides: Partial<LaneBusDeps> = {}) {
  const handlers = new Map<string, (message: string) => void>();
  const published: Array<{ channel: string; message: string }> = [];

  const bus: LaneBusDeps = {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      handlers.get(channel)?.(message);
      return 1;
    }),
    listen: vi.fn((channel: string, handler: (message: string) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
    apply: vi.fn(),
    channel: () => "socket.io:lane",
    replica: () => "api-1",
    listens: () => true,
    ...overrides,
  };

  return { bus, published, handlers };
}

const PAUSE = {
  template: "entrega_saiu",
  action: "pause" as const,
  seconds: 60,
};

describe("the lane's channel", () => {
  it("is outside every pattern the Socket.IO adapter subscribes to", () => {
    const channel = laneChannel("socket.io");

    expect(channel).toBe("socket.io:lane");

    for (const prefix of [
      "socket.io#",
      "socket.io-request#",
      "socket.io-response#",
    ]) {
      expect(channel.startsWith(prefix)).toBe(false);
    }
  });
});

describe("a change published", () => {
  it("carries the change, the publisher and the message's version", async () => {
    const { bus, published } = deps();

    await publishTemplateLaneChange(PAUSE, bus);

    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0].message)).toEqual({
      v: 1,
      replica: "api-1",
      change: PAUSE,
    });
  });

  it("never throws out of Meta's callback when Redis refuses", async () => {
    const { bus } = deps({
      publish: vi.fn(async () => {
        throw new Error("Redis indisponível");
      }),
    });

    await expect(
      publishTemplateLaneChange(PAUSE, bus),
    ).resolves.toBeUndefined();
  });
});

describe("the listener", () => {
  it("applies another process's change", async () => {
    const worker = deps({ replica: () => "worker-external-1" });
    const stop = startTemplateLaneListener(worker.bus);

    const handler = worker.handlers.get("socket.io:lane");

    handler?.(JSON.stringify({ v: 1, replica: "api-1", change: PAUSE }));

    expect(worker.bus.apply).toHaveBeenCalledWith(PAUSE);

    stop();
  });

  it("does not apply its own change a second time", () => {
    const { bus, handlers } = deps();

    startTemplateLaneListener(bus);
    handlers.get("socket.io:lane")?.(
      JSON.stringify({ v: 1, replica: "api-1", change: PAUSE }),
    );

    expect(bus.apply).not.toHaveBeenCalled();
  });

  it("ignores what is not a lane message", () => {
    const { bus, handlers } = deps({ replica: () => "worker-1" });

    startTemplateLaneListener(bus);

    const handler = handlers.get("socket.io:lane");

    for (const raw of [
      "not json",
      JSON.stringify({ replica: "api-1", change: PAUSE }),
      JSON.stringify({ v: 0, replica: "api-1", change: PAUSE }),
      JSON.stringify({ v: 1, change: PAUSE }),
      JSON.stringify({ v: 1, replica: "api-1", change: null }),
    ]) {
      handler?.(raw);
    }

    expect(bus.apply).not.toHaveBeenCalled();
  });

  it("accepts a newer version's message: the change inside is validated on its own", () => {
    expect(
      parseLaneMessage(
        JSON.stringify({ v: 2, replica: "api-9", change: PAUSE, extra: 1 }),
      ),
    ).toEqual({ v: 2, replica: "api-9", change: PAUSE });
  });

  it("listens nowhere a process hears the adapter or drains no external queue", () => {
    const { bus } = deps({ listens: () => false });

    startTemplateLaneListener(bus);

    expect(bus.listen).not.toHaveBeenCalled();
  });
});
