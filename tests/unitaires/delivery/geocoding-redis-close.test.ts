import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeGeocodingRedis,
  geocodingRedis,
} from "@/shared/delivery/geocoding/geocoding-runtime";

/**
 * The geocoding's Redis connection is closed by the workers' step of the
 * graceful shutdown (plano-escala F1-14), after the cron that shares it.
 * Its QUIT had no bound: a Redis that stopped answering held the step past
 * its deadline, until the watchdog's exit(1) came before closeRedis. The
 * close now gets what is left of the step, and past it the connection is
 * dropped instead of quit. Without a plan (a test, a developer's Ctrl+C) it
 * waits for the QUIT, as before.
 */
const redis = vi.hoisted(() => ({
  quit: vi.fn<[], Promise<unknown>>(),
  disconnect: vi.fn(),
}));

vi.mock("ioredis", () => ({
  default: class {
    quit = redis.quit;
    disconnect = redis.disconnect;
    on() {
      return this;
    }
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  redis.quit.mockReset();
  redis.disconnect.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function openThenClose(options?: { deadlineMs?: number }) {
  geocodingRedis();

  let settled = false;
  const closing = closeGeocodingRedis(options).then(() => {
    settled = true;
  });

  return { closing, settled: () => settled };
}

describe("closing the geocoding's Redis connection", () => {
  it("drops the connection once the deadline passes with the QUIT unanswered", async () => {
    redis.quit.mockReturnValue(new Promise(() => {}));

    const { closing, settled } = openThenClose({ deadlineMs: 200 });

    await vi.advanceTimersByTimeAsync(199);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it("quits cleanly when Redis answers in time", async () => {
    redis.quit.mockResolvedValue("OK");

    const { closing } = openThenClose({ deadlineMs: 200 });
    await closing;

    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it("drops the connection when the QUIT is refused", async () => {
    redis.quit.mockRejectedValue(new Error("Connection is closed."));

    const { closing } = openThenClose({ deadlineMs: 200 });
    await closing;

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it("waits for the QUIT without a plan", async () => {
    let answer!: (value: unknown) => void;
    redis.quit.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const { closing, settled } = openThenClose();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled()).toBe(false);

    answer("OK");
    await closing;

    expect(redis.disconnect).not.toHaveBeenCalled();
  });
});
