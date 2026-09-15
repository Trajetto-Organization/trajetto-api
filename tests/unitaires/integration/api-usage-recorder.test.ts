import { describe, expect, it, vi } from "vitest";

import {
  ApiUsageRecorder,
  MAX_BUCKETS,
  statusClassOf,
  utcDay,
} from "@/shared/integration/api-usage-recorder";

const upsert = vi.fn();

vi.mock("@/../infra/database", () => ({
  default: {
    apiKeyUsageDaily: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

/**
 * The counter behind "o ERP deles chamou, e o que aconteceu?".
 *
 * Everything here is about NOT being a request log. A row per call would be
 * tens of millions of rows a month to answer a question that is always a
 * count, so the buffer collapses calls into buckets and the flush is the only
 * thing that touches the database.
 */
function recorder(): ApiUsageRecorder {
  upsert.mockReset();
  upsert.mockResolvedValue({});

  return new ApiUsageRecorder();
}

const CALL = {
  apiKeyId: "key-1",
  businessId: "business-1",
  method: "get",
  route: "/integration/v1/deliveries",
  status: 200,
  at: new Date("2026-09-15T13:00:00.000Z"),
};

describe("classifying an answer", () => {
  it("collapses a status into the three conversations that exist", () => {
    // "Funcionou", "o cliente errou", "nós erramos". A screen with one column
    // per status code is a screen nobody reads.
    expect(statusClassOf(200)).toBe(2);
    expect(statusClassOf(201)).toBe(2);
    expect(statusClassOf(304)).toBe(2);

    expect(statusClassOf(401)).toBe(4);
    expect(statusClassOf(422)).toBe(4);

    expect(statusClassOf(500)).toBe(5);
    expect(statusClassOf(503)).toBe(5);
  });

  it("counts anything it cannot classify as our problem", () => {
    // A status outside 200–599 is a status we wrote wrong, and hiding it in
    // the success column is how it stays wrong.
    expect(statusClassOf(0)).toBe(5);
    expect(statusClassOf(999)).toBe(5);
  });
});

describe("which day a call belongs to", () => {
  it("is UTC, so two replicas in two timezones agree", () => {
    expect(utcDay(new Date("2026-09-15T23:59:59.000Z"))).toBe("2026-09-15");
    expect(utcDay(new Date("2026-09-16T00:00:01.000Z"))).toBe("2026-09-16");
  });
});

describe("holding calls before writing them", () => {
  it("writes nothing until a flush", async () => {
    const counter = recorder();

    for (let index = 0; index < 50; index += 1) counter.record(CALL);

    // The whole point: fifty calls are not fifty transactions queuing on one
    // row.
    expect(upsert).not.toHaveBeenCalled();
    expect(counter.pending()).toBe(1);
  });

  it("collapses identical calls into one increment", async () => {
    const counter = recorder();

    for (let index = 0; index < 50; index += 1) counter.record(CALL);

    expect(await counter.flush()).toBe(1);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].update).toEqual({
      count: { increment: 50 },
    });
  });

  it("increments rather than replaces, so two replicas add up", async () => {
    const counter = recorder();

    counter.record(CALL);
    await counter.flush();

    // `set` here would mean the second replica to flush erases the first
    // one's counts — and the number would be wrong in the direction nobody
    // checks, downwards.
    expect(upsert.mock.calls[0][0].update.count).toHaveProperty("increment");
    expect(upsert.mock.calls[0][0].create.count).toBe(1);
  });

  it("keeps methods, routes, days and classes in separate buckets", async () => {
    const counter = recorder();

    counter.record(CALL);
    counter.record({ ...CALL, method: "post" });
    counter.record({ ...CALL, route: "/integration/v1/routes" });
    counter.record({ ...CALL, status: 422 });
    counter.record({ ...CALL, at: new Date("2026-09-16T01:00:00.000Z") });
    counter.record({ ...CALL, apiKeyId: "key-2" });

    expect(counter.pending()).toBe(6);
  });

  it("does not care how the method was capitalised", async () => {
    const counter = recorder();

    counter.record({ ...CALL, method: "get" });
    counter.record({ ...CALL, method: "GET" });

    // Two buckets for the same thing would split a customer's traffic in half
    // on the screen, for a reason nobody could ever work out from it.
    expect(counter.pending()).toBe(1);
  });

  it("empties the buffer before the write, not after", async () => {
    const counter = recorder();

    let pendingDuringWrite = -1;

    upsert.mockImplementation(async () => {
      pendingDuringWrite = counter.pending();

      // A call arriving mid-flush. It belongs to the NEXT batch: counted here
      // it would be written twice, and dropped here it would be lost.
      counter.record(CALL);

      return {};
    });

    counter.record(CALL);

    await counter.flush();

    expect(pendingDuringWrite).toBe(0);
    expect(counter.pending()).toBe(1);
  });
});

describe("when something goes wrong", () => {
  it("keeps counting the rest after one row fails", async () => {
    const counter = recorder();

    upsert
      .mockRejectedValueOnce(new Error("chave revogada no meio do flush"))
      .mockResolvedValue({});

    vi.spyOn(console, "error").mockImplementation(() => {});

    counter.record(CALL);
    counter.record({ ...CALL, route: "/integration/v1/routes" });

    // A counter that cannot be written must never take down the process that
    // was only trying to write one.
    expect(await counter.flush()).toBe(1);

    vi.restoreAllMocks();
  });

  it("stops growing instead of growing forever", async () => {
    const counter = recorder();

    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let index = 0; index < MAX_BUCKETS + 10; index += 1) {
      counter.record({ ...CALL, route: `/integration/v1/r${index}` });
    }

    // Reached only if something is already wrong — a route pattern that is
    // not a pattern. Dropping counts beats an out-of-memory for a monitor.
    expect(counter.pending()).toBe(MAX_BUCKETS);

    vi.restoreAllMocks();
  });

  it("says out loud that it dropped something", async () => {
    const counter = recorder();

    const warned: unknown[] = [];

    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });

    for (let index = 0; index < MAX_BUCKETS + 3; index += 1) {
      counter.record({ ...CALL, route: `/integration/v1/r${index}` });
    }

    await counter.flush();

    // Silence here would mean a screen quietly showing fewer calls than
    // happened, which is worse than the screen being down.
    expect(warned).toHaveLength(1);
    expect(String(warned[0])).toContain("3");

    vi.restoreAllMocks();
  });
});
