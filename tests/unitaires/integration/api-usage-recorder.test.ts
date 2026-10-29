import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import {
  ApiUsageRecorder,
  MAX_BUCKETS,
  MAX_FLUSH_ATTEMPTS,
  statusClassOf,
  usageDay,
} from "@/shared/integration/api-usage-recorder";

import { clearLogged, logged } from "../../support/log-capture";

/**
 * The database seen by the recorder: the batched statement and the one-bucket
 * fallback. What the SQL itself does (insert or increment, two replicas adding
 * up) is proven against Postgres in tests/E2E/api-usage-recorder-flush.test.ts;
 * this file is about the buffer around it.
 */
const executeRaw = vi.fn();
const upsert = vi.fn();

vi.mock("@/../infra/database", () => ({
  default: {
    $executeRaw: (...args: unknown[]) => executeRaw(...args),
    apiKeyUsageDaily: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

// The recorder writes through the shared logger (OBS-14); these lines are
// what it wrote.
vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

beforeEach(() => {
  clearLogged();
});

function recorder(): ApiUsageRecorder {
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(1);

  upsert.mockReset();
  upsert.mockResolvedValue({});

  return new ApiUsageRecorder();
}

/** The values bound to the batched INSERT, by column. */
function batchOf(call: unknown[]) {
  const [
    ,
    ids,
    apiKeyIds,
    businessIds,
    days,
    methods,
    routes,
    classes,
    counts,
  ] = call as [
    unknown,
    string[],
    string[],
    string[],
    string[],
    string[],
    string[],
    number[],
    bigint[],
  ];

  return {
    ids,
    apiKeyIds,
    businessIds,
    days,
    methods,
    routes,
    classes,
    counts,
  };
}

const CALL = {
  apiKeyId: "key-1",
  businessId: "business-1",
  timeZone: "America/Sao_Paulo",
  method: "get",
  route: "/integration/v1/deliveries",
  status: 200,
  at: new Date("2026-09-15T13:00:00.000Z"),
};

const connectionLost = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
    code: "P1001",
    clientVersion: "test",
  });

const missingKey = () =>
  new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
    code: "P2003",
    clientVersion: "test",
  });

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

describe("which day a call belongs to (DLVB-33)", () => {
  it("is the company's day, not the UTC one, around the evening turn", () => {
    // 21:30 in São Paulo is already the next day in UTC: "Hoje" used to reset
    // to zero at 21:00 and show the previous evening until 03:00.
    expect(
      usageDay(new Date("2026-09-16T00:30:00.000Z"), "America/Sao_Paulo"),
    ).toBe("2026-09-15");
    expect(
      usageDay(new Date("2026-09-16T02:59:59.000Z"), "America/Sao_Paulo"),
    ).toBe("2026-09-15");
    expect(
      usageDay(new Date("2026-09-16T03:00:00.000Z"), "America/Sao_Paulo"),
    ).toBe("2026-09-16");
  });

  it("follows each company's own zone", () => {
    // Manaus is an hour behind São Paulo: 03:30Z is still the 15th there.
    expect(
      usageDay(new Date("2026-09-16T03:30:00.000Z"), "America/Manaus"),
    ).toBe("2026-09-15");
    expect(
      usageDay(new Date("2026-09-16T03:30:00.000Z"), "America/Sao_Paulo"),
    ).toBe("2026-09-16");
  });

  it("falls back to the default zone when the company carries none", () => {
    expect(usageDay(new Date("2026-09-16T01:00:00.000Z"), null)).toBe(
      "2026-09-15",
    );
    expect(usageDay(new Date("2026-09-16T01:00:00.000Z"), "Not/AZone")).toBe(
      "2026-09-15",
    );
  });

  it("is the day written to the table", async () => {
    const counter = recorder();

    counter.record({ ...CALL, at: new Date("2026-09-16T01:30:00.000Z") });
    await counter.flush();

    expect(batchOf(executeRaw.mock.calls[0]).days).toEqual(["2026-09-15"]);
  });
});

describe("holding calls before writing them", () => {
  it("writes nothing until a flush", async () => {
    const counter = recorder();

    for (let index = 0; index < 50; index += 1) counter.record(CALL);

    // The whole point: fifty calls are not fifty transactions queuing on one
    // row.
    expect(executeRaw).not.toHaveBeenCalled();
    expect(counter.pending()).toBe(1);
  });

  it("collapses identical calls into one bucket carrying the count", async () => {
    const counter = recorder();

    for (let index = 0; index < 50; index += 1) counter.record(CALL);

    expect(await counter.flush()).toBe(1);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(batchOf(executeRaw.mock.calls[0]).counts).toEqual([50n]);
  });

  it("writes a whole flush in one statement, not one per bucket", async () => {
    const counter = recorder();

    for (let index = 0; index < 40; index += 1) {
      counter.record({ ...CALL, route: `/integration/v1/r${index}` });
    }

    expect(await counter.flush()).toBe(40);

    // Forty sequential upserts every ten seconds per replica was the cost.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(batchOf(executeRaw.mock.calls[0]).routes).toHaveLength(40);
  });

  it("keeps methods, routes, days and classes in separate buckets", async () => {
    const counter = recorder();

    counter.record(CALL);
    counter.record({ ...CALL, method: "post" });
    counter.record({ ...CALL, route: "/integration/v1/routes" });
    counter.record({ ...CALL, status: 422 });
    counter.record({ ...CALL, at: new Date("2026-09-17T01:00:00.000Z") });
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

    executeRaw.mockImplementation(async () => {
      pendingDuringWrite = counter.pending();

      // A call arriving mid-flush. It belongs to the NEXT batch: counted here
      // it would be written twice, and dropped here it would be lost.
      counter.record(CALL);

      return 1;
    });

    counter.record(CALL);

    await counter.flush();

    expect(pendingDuringWrite).toBe(0);
    expect(counter.pending()).toBe(1);
  });
});

describe("when something goes wrong (DLVB-34)", () => {
  it("keeps what could not be written for the next flush", async () => {
    const counter = recorder();

    executeRaw.mockRejectedValueOnce(connectionLost());

    counter.record(CALL);
    counter.record(CALL);
    counter.record({ ...CALL, route: "/integration/v1/routes" });

    // The buffer is cleared before writing, so a failed write used to lose
    // the counts for good.
    expect(await counter.flush()).toBe(0);
    expect(counter.pending()).toBe(2);

    expect(await counter.flush()).toBe(2);

    const retried = batchOf(executeRaw.mock.calls[1]);

    expect(retried.counts.reduce((sum, count) => sum + count, 0n)).toBe(3n);
  });

  it("adds a kept bucket to the calls that arrived meanwhile", async () => {
    const counter = recorder();

    executeRaw.mockRejectedValueOnce(connectionLost());

    counter.record(CALL);
    await counter.flush();

    counter.record(CALL);
    counter.record(CALL);

    expect(counter.pending()).toBe(1);

    await counter.flush();

    expect(batchOf(executeRaw.mock.calls[1]).counts).toEqual([3n]);
  });

  it("gives a bucket up after repeated failures, and says so", async () => {
    const counter = recorder();

    executeRaw.mockRejectedValue(connectionLost());

    counter.record(CALL);

    for (let attempt = 0; attempt < MAX_FLUSH_ATTEMPTS; attempt += 1) {
      await counter.flush();
    }

    // Circling forever would hold the buffer's ceiling hostage.
    expect(counter.pending()).toBe(0);
    expect(logged("error")).toHaveLength(1);
    expect(logged("error")[0]).toMatchObject({
      component: "api-usage",
      count: 1,
    });
  });

  it("isolates a bucket whose key no longer exists, and keeps the rest", async () => {
    const counter = recorder();

    // One missing parent fails the whole statement...
    executeRaw.mockRejectedValueOnce(missingKey());

    // ...so the chunk is written bucket by bucket, and only that one fails.
    upsert.mockRejectedValueOnce(missingKey()).mockResolvedValue({});

    counter.record({ ...CALL, apiKeyId: "key-deleted" });
    counter.record({ ...CALL, apiKeyId: "key-2" });

    expect(await counter.flush()).toBe(1);

    // Discarded, not kept: nothing will ever count against a deleted key.
    expect(counter.pending()).toBe(0);
    expect(logged("warn")).toHaveLength(1);
  });

  it("stops growing instead of growing forever", async () => {
    const counter = recorder();

    for (let index = 0; index < MAX_BUCKETS + 10; index += 1) {
      counter.record({ ...CALL, route: `/integration/v1/r${index}` });
    }

    // Reached only if something is already wrong — a route pattern that is
    // not a pattern. Dropping counts beats an out-of-memory for a monitor.
    expect(counter.pending()).toBe(MAX_BUCKETS);
  });

  it("says out loud that it dropped something", async () => {
    const counter = recorder();

    for (let index = 0; index < MAX_BUCKETS + 3; index += 1) {
      counter.record({ ...CALL, route: `/integration/v1/r${index}` });
    }

    await counter.flush();

    // Silence here would mean a screen quietly showing fewer calls than
    // happened, which is worse than the screen being down.
    const warned = logged("warn");

    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ component: "api-usage", dropped: 3 });
  });
});
