import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import {
  IMPORT_HANDBACK_WRITE_MS,
  IMPORT_STOP_GRACE_MS,
  ImportQueue,
} from "@/modules/import/services/import-queue";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { WEBHOOK_TIMEOUT_MS } from "@/shared/integration/webhook-dispatch-rules";

import { clearLogged, logged } from "../../support/log-capture";

/**
 * The uploads a replica processes after answering them: one at a time, a
 * few waiting, the rest refused before anything is written — and a waiting
 * one kept alive for the abandoned-import sweep.
 */
function job(importId: string, gate?: Promise<void>) {
  const calls = {
    ran: 0,
    beats: 0,
    abandoned: [] as string[],
    signal: null as AbortSignal | null,
  };

  return {
    calls,
    job: {
      importId,
      run: async (signal: AbortSignal) => {
        calls.ran += 1;
        calls.signal = signal;
        await gate;
      },
      heartbeat: async () => {
        calls.beats += 1;
      },
      abandon: async (stage: string) => {
        calls.abandoned.push(stage);
      },
    },
  };
}

/**
 * A running upload that honours the stop signal the way the spreadsheet
 * import does: it finishes the row it is on and closes its own record.
 */
function cooperativeJob(importId: string) {
  const calls = { rows: 0, closedOnStop: false, abandoned: [] as string[] };

  return {
    calls,
    job: {
      importId,
      run: async (signal: AbortSignal) => {
        while (!signal.aborted) {
          calls.rows += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        calls.closedOnStop = true;
      },
      heartbeat: async () => {},
      abandon: async (stage: string) => {
        calls.abandoned.push(stage);
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
      abandon: async () => {},
    };
    const b = {
      importId: "b",
      run: async () => {
        order.push("b:start");
      },
      heartbeat: async () => {},
      abandon: async () => {},
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
      abandon: async () => {},
    });
    queue.reserve().submit(after.job);

    await queue.idle();

    expect(after.calls.ran).toBe(1);
    expect(queue.size()).toBe(0);
  });
});

/**
 * A replica shutting down (SIGTERM, the shutdown sequence calls `drain`).
 *
 * Before: nothing told the queue. The running upload was cut mid-file and up
 * to three waiting ones — already answered 202 — vanished; each record sat
 * IN_PROGRESS until the abandoned-import sweep closed it 15–20 minutes later.
 */
describe("the import queue, when the replica shuts down", () => {
  it("hands every waiting upload back at once, and never runs them", async () => {
    const queue = new ImportQueue(1, 3);
    const hold = gate();
    const running = job("running", hold.opened);
    const waiting = [job("w1"), job("w2"), job("w3")];

    queue.reserve().submit(running.job);
    for (const entry of waiting) queue.reserve().submit(entry.job);

    const drained = queue.drain({ graceMs: 60_000 });

    // Handed back before the running one even finishes.
    await new Promise((resolve) => setImmediate(resolve));

    for (const entry of waiting) {
      expect(entry.calls.abandoned).toEqual(["waiting"]);
    }

    hold.open();
    await drained;

    for (const entry of waiting) expect(entry.calls.ran).toBe(0);

    expect(running.calls.abandoned).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("refuses new uploads with 429 IMPORT_BUSY and a Retry-After", async () => {
    const queue = new ImportQueue(1, 3);

    const drained = queue.drain({ graceMs: 0 });

    const refused = (() => {
      try {
        queue.reserve();
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(refused).toBeInstanceOf(ServiceBusyError);
    expect(refused).toMatchObject({
      statusCode: 429,
      code: "IMPORT_BUSY",
      retryAfterSeconds: 30,
    });

    // A large undo reserves here too, and it sends no file.
    expect((refused as Error).message).not.toMatch(/arquivo/i);

    await drained;
  });

  it("lets the running upload finish inside the grace period", async () => {
    const queue = new ImportQueue(1, 3);
    const hold = gate();
    const running = job("running", hold.opened);

    queue.reserve().submit(running.job);

    const drained = queue.drain({ graceMs: 60_000 });

    setTimeout(() => hold.open(), 20);
    await drained;

    expect(running.calls.signal?.aborted).toBe(false);
    expect(running.calls.abandoned).toEqual([]);
  });

  it("asks the running upload to stop after the grace period, and it closes itself", async () => {
    const queue = new ImportQueue(1, 3);
    const running = cooperativeJob("running");

    queue.reserve().submit(running.job);

    const started = Date.now();

    await queue.drain({ graceMs: 50, stopGraceMs: 2_000 });

    expect(running.calls.closedOnStop).toBe(true);
    expect(running.calls.rows).toBeGreaterThan(0);
    expect(running.calls.abandoned).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("hands back a running upload that does not stop in time", async () => {
    const queue = new ImportQueue(1, 3);

    // Stuck in one call: ignores the signal (a workbook still being parsed,
    // a database that stopped answering).
    const stuck = job("stuck", new Promise<void>(() => {}));

    queue.reserve().submit(stuck.job);

    await queue.drain({ graceMs: 20, stopGraceMs: 20 });

    expect(stuck.calls.signal?.aborted).toBe(true);
    expect(stuck.calls.abandoned).toEqual(["running"]);
  });

  it("hands back an upload whose reservation is submitted after the drain began", async () => {
    const queue = new ImportQueue(1, 3);
    const late = job("late");

    // Reserved while the request was validating; the record opened after
    // SIGTERM.
    const ticket = queue.reserve();
    const drained = queue.drain({ graceMs: 1_000 });

    ticket.submit(late.job);
    await drained;

    expect(late.calls.ran).toBe(0);
    expect(late.calls.abandoned).toEqual(["waiting"]);
  });

  it("waits for the hand-backs to be written before it resolves", async () => {
    const queue = new ImportQueue(1, 3);
    const hold = gate();
    const write = gate();
    let written = false;

    queue.reserve().submit(job("running", hold.opened).job);
    queue.reserve().submit({
      importId: "waiting",
      run: async () => {},
      heartbeat: async () => {},
      abandon: async () => {
        await write.opened;
        written = true;
      },
    });

    hold.open();

    const drained = queue.drain({ graceMs: 1_000 });
    let settled = false;
    void drained.then(() => (settled = true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    write.open();
    await drained;

    expect(written).toBe(true);
  });

  it("keeps draining when a hand-back fails, and joins a second call", async () => {
    const queue = new ImportQueue(1, 3);
    const hold = gate();
    const other = job("other");

    queue.reserve().submit(job("running", hold.opened).job);
    queue.reserve().submit({
      importId: "failing",
      run: async () => {},
      heartbeat: async () => {},
      abandon: async () => {
        throw new Error("database unavailable");
      },
    });
    queue.reserve().submit(other.job);

    const first = queue.drain({ graceMs: 1_000 });
    const second = queue.drain({ graceMs: 1_000 });

    expect(second).toBe(first);

    hold.open();
    await first;

    expect(other.calls.abandoned).toEqual(["waiting"]);
  });

  // The hand-back writes used to be awaited with no limit: on a database
  // that stopped answering they took the pool timeout, and the workers'
  // shutdown after them went past the watchdog, which forced exit(1).
  it("stops waiting for a hand-back write that does not come back, and says which", async () => {
    vi.useFakeTimers();
    clearLogged();

    try {
      const queue = new ImportQueue(1, 3);
      const hold = gate();
      let settled = false;

      queue.reserve().submit(job("running", hold.opened).job);
      queue.reserve().submit({
        importId: "stuck-write",
        run: async () => {},
        heartbeat: async () => {},
        // The database never answers.
        abandon: () => new Promise<void>(() => {}),
      });

      const drained = queue.drain({ graceMs: 1_000, handBackMs: 2_000 });
      void drained.then(() => (settled = true));

      hold.open();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      expect(
        logged("warn").find((line) =>
          line.msg?.includes("not written in time"),
        ),
      ).toMatchObject({ pending: ["stuck-write"], waitedMs: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends inside the shutdown watchdog with the workers' deadline still to come", async () => {
    vi.useFakeTimers();

    try {
      const queue = new ImportQueue(1, 3);

      // The worst case: stuck in one call, and its hand-back never written.
      queue.reserve().submit({
        importId: "stuck",
        run: () => new Promise<void>(() => {}),
        heartbeat: async () => {},
        abandon: () => new Promise<void>(() => {}),
      });

      // server.ts: IMPORT_DRAIN_GRACE_MS (15 s in production) and the 35 s
      // SHUTDOWN_TIMEOUT_MS; the slowest worker is the webhook dispatcher,
      // a call timeout plus 2 s (webhook-dispatch-service.ts).
      const graceMs = 15_000;
      const watchdogMs = 35_000;
      const workersMs = WEBHOOK_TIMEOUT_MS + 2_000;

      const startedAt = Date.now();
      const drain: { endedAfterMs: number | null } = { endedAfterMs: null };

      void queue
        .drain({ graceMs })
        .then(() => (drain.endedAfterMs = Date.now() - startedAt));

      await vi.advanceTimersByTimeAsync(watchdogMs);

      expect(drain.endedAfterMs).toBe(
        graceMs + IMPORT_STOP_GRACE_MS + IMPORT_HANDBACK_WRITE_MS,
      );
      expect((drain.endedAfterMs ?? Infinity) + workersMs).toBeLessThan(
        watchdogMs,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
