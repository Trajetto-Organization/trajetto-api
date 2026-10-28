import { describe, expect, it, vi } from "vitest";

import { ImportQueue } from "@/modules/import/services/import-queue";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";

/**
 * The uploads a replica processes after answering them: one at a time, a
 * few waiting, the rest refused before anything is written — and a waiting
 * one kept alive for the abandoned-import sweep.
 */
function job(importId: string, gate?: Promise<void>) {
  const calls = { ran: 0, beats: 0 };

  return {
    calls,
    job: {
      importId,
      run: async () => {
        calls.ran += 1;
        await gate;
      },
      heartbeat: async () => {
        calls.beats += 1;
      },
    },
  };
}

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { opened, open };
}

describe("the import queue", () => {
  it("runs one upload at a time, in arrival order", async () => {
    const queue = new ImportQueue(1, 3);
    const first = gate();
    const order: string[] = [];

    const a = {
      importId: "a",
      run: async () => {
        order.push("a:start");
        await first.opened;
        order.push("a:end");
      },
      heartbeat: async () => {},
    };
    const b = {
      importId: "b",
      run: async () => {
        order.push("b:start");
      },
      heartbeat: async () => {},
    };

    queue.reserve().submit(a);
    queue.reserve().submit(b);

    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(["a:start"]);
    expect(queue.size()).toBe(2);

    first.open();
    await queue.idle();

    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("refuses past its capacity with 429 IMPORT_BUSY, before anything is written", () => {
    const queue = new ImportQueue(1, 1);
    const hold = gate();

    queue.reserve().submit(job("a", hold.opened).job);
    queue.reserve();

    const refused = (() => {
      try {
        queue.reserve();
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(refused).toBeInstanceOf(ServiceBusyError);
    expect(refused).toMatchObject({ statusCode: 429, code: "IMPORT_BUSY" });

    hold.open();
  });

  it("gives a cancelled reservation back", () => {
    const queue = new ImportQueue(1, 0);

    const ticket = queue.reserve();

    expect(() => queue.reserve()).toThrow(ServiceBusyError);

    ticket.cancel();

    expect(() => queue.reserve()).not.toThrow();
  });

  it("keeps a waiting upload's heartbeat, and stops it once it runs", async () => {
    vi.useFakeTimers();

    try {
      const queue = new ImportQueue(1, 3, 1_000);
      const hold = gate();
      const running = job("running", hold.opened);
      const waiting = job("waiting");

      queue.reserve().submit(running.job);
      queue.reserve().submit(waiting.job);

      await vi.advanceTimersByTimeAsync(3_500);

      expect(waiting.calls.beats).toBe(3);
      expect(running.calls.beats).toBe(0);

      hold.open();
      await vi.advanceTimersByTimeAsync(0);
      await queue.idle();

      const beats = waiting.calls.beats;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(waiting.calls.beats).toBe(beats);
      expect(waiting.calls.ran).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a job that throws", async () => {
    const queue = new ImportQueue(1, 3);
    const after = job("after");

    queue.reserve().submit({
      importId: "broken",
      run: async () => {
        throw new Error("database unavailable");
      },
      heartbeat: async () => {},
    });
    queue.reserve().submit(after.job);

    await queue.idle();

    expect(after.calls.ran).toBe(1);
    expect(queue.size()).toBe(0);
  });
});
