import { describe, expect, it, vi } from "vitest";

vi.mock("@/websocket", () => ({
  sendRouteEventToDriver: vi.fn(),
  sendRouteStopsLocatedToBusiness: vi.fn(),
}));

import type { GeocodingRunResult } from "@/shared/delivery/geocoding/delivery-geocoding-service";
import { pauseValue } from "@/shared/delivery/geocoding/geocoding-gate";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";
import {
  createGeocodingRunLog,
  redisReadHold,
} from "@/shared/delivery/geocoding/geocoding-runtime";

/**
 * What the geocoding says about being held (owner's report of 14/11/2026):
 * a held run logged at debug, which LOG_LEVEL=info never shows, so a
 * staging whose lookups the provider refused, or whose budget was spent,
 * said nothing between two refusals or nothing at all, and "Sem
 * localização" had no explanation in the log. Now each change of what
 * holds the lookups is one info line per process — never one a minute.
 */
const NOW = new Date("2026-11-14T15:00:00.000Z");
const UNTIL = new Date("2026-11-14T15:15:00.000Z");

function empty(
  overrides: Partial<GeocodingRunResult> = {},
): GeocodingRunResult {
  return {
    claimed: 0,
    resolved: 0,
    coarse: 0,
    notFound: 0,
    failed: 0,
    released: 0,
    providerStatuses: [],
    settled: [],
    ...overrides,
  };
}

function refusedRun(status: number): GeocodingRunResult {
  return empty({
    claimed: 2,
    released: 2,
    stoppedBy: "REFUSED",
    providerStatuses: [status],
    hold: { pause: { reason: "REFUSED", until: UNTIL, status }, used: null },
  });
}

function heldByPause(
  reason: "REFUSED" | "QUOTA" | "BURST",
  status: number | null,
  until = UNTIL,
): GeocodingRunResult {
  return empty({
    skipped: "PAUSED",
    hold: { pause: { reason, until, status }, used: 40 },
  });
}

function harness(budget = 2_000) {
  const lines: Array<{
    level: string;
    details: Record<string, unknown>;
    message: string;
  }> = [];
  const record =
    (level: string) => (details: Record<string, unknown>, message: string) =>
      lines.push({ level, details, message });

  const logRun = createGeocodingRunLog(
    { info: record("info"), warn: record("warn"), error: record("error") },
    () => budget,
    () => NOW,
  );

  return { lines, logRun };
}

describe("the line for each change of what holds the lookups", () => {
  it("says a refusal once, with the HTTP and the deadline, never again each minute", () => {
    const { lines, logRun } = harness();

    logRun("job", refusedRun(401));
    logRun("job", heldByPause("REFUSED", 401));
    logRun("soon", heldByPause("REFUSED", 401));
    // The pause ran out, the next run was refused again: still the same.
    logRun("job", refusedRun(401));

    const held = lines.filter((line) =>
      line.message.startsWith("geocoding held"),
    );

    expect(held).toEqual([
      {
        level: "info",
        details: {
          source: "job",
          pauseReason: "REFUSED",
          until: UNTIL.toISOString(),
          refusedStatus: 401,
        },
        message:
          "geocoding held: provider refused (HTTP 401) until 2026-11-14T15:15:00.000Z; check REVERSE_GEOCODER_URL and REVERSE_GEOCODER_KEY",
      },
    ]);
    // The run's own lines are as before: the refusal at error, each time.
    expect(
      lines.filter((line) => line.level === "error").map((line) => line.level),
    ).toEqual(["error", "error"]);
  });

  it("says a pause another replica set, read from Redis, at info", () => {
    const { lines, logRun } = harness();

    logRun(
      "job",
      heldByPause("QUOTA", 429, new Date("2026-11-15T00:00:00.000Z")),
    );
    logRun(
      "job",
      heldByPause("QUOTA", 429, new Date("2026-11-15T00:00:00.000Z")),
    );

    expect(lines).toEqual([
      {
        level: "info",
        details: {
          source: "job",
          pauseReason: "QUOTA",
          until: "2026-11-15T00:00:00.000Z",
        },
        message:
          "geocoding held: provider daily quota until 2026-11-15T00:00:00.000Z",
      },
    ]);
  });

  it("says today's budget spent with the count, and once", () => {
    const { lines, logRun } = harness(2_000);
    const spent = empty({
      skipped: "BUDGET",
      hold: { pause: null, used: 2_003 },
    });

    logRun("job", spent);
    logRun("job", spent);

    expect(lines).toEqual([
      {
        level: "info",
        details: {
          source: "job",
          todayUsed: 2_003,
          dailyBudget: 2_000,
          until: "2026-11-15T00:00:00.000Z",
        },
        message:
          "geocoding held: budget spent for today (2003/2000); see DELIVERY_GEOCODING_DAILY_BUDGET",
      },
    ]);
  });

  it("says when the lookups run again, and a new hold after it", () => {
    const { lines, logRun } = harness();

    logRun("job", refusedRun(403));
    logRun("job", empty({ claimed: 1, resolved: 1 }));
    logRun("job", empty());
    logRun("job", heldByPause("REFUSED", 404));

    expect(
      lines
        .filter((line) => line.level === "info")
        .map((line) => [line.message.split(":")[0], line.details]),
    ).toEqual([
      [
        "geocoding held",
        {
          source: "job",
          pauseReason: "REFUSED",
          until: UNTIL.toISOString(),
          refusedStatus: 403,
        },
      ],
      ["geocoding running again", { source: "job", previous: "REFUSED 403" }],
      [
        "delivery addresses geocoded",
        expect.objectContaining({ source: "job", resolved: 1 }),
      ],
      [
        "geocoding held",
        {
          source: "job",
          pauseReason: "REFUSED",
          until: UNTIL.toISOString(),
          refusedStatus: 404,
        },
      ],
    ]);
  });

  it("says nothing for a burst's minute, a pause it could not read, or a process never held", () => {
    const { lines, logRun } = harness();

    logRun("job", empty());
    logRun("job", heldByPause("BURST", 429));
    logRun("job", empty({ skipped: "PAUSED", hold: null }));
    logRun("job", empty({ skipped: "PAUSED" }));
    logRun("job", empty());

    expect(lines).toEqual([]);
  });
});

describe("what a held run reads from Redis", () => {
  it("reads the pause with its status and today's count in one MGET", async () => {
    const asked: string[][] = [];
    const values = new Map([
      [GEOCODING_KEYS.pause, pauseValue("REFUSED", UNTIL, 401)],
      [GEOCODING_KEYS.budget(NOW), "37"],
    ]);
    const read = redisReadHold({
      mget: (async (...keys: string[]) => {
        asked.push(keys);

        return keys.map((key) => values.get(key) ?? null);
      }) as never,
    });

    expect(await read(NOW)).toEqual({
      pause: { reason: "REFUSED", until: UNTIL, status: 401 },
      used: 37,
    });
    expect(asked).toEqual([[GEOCODING_KEYS.pause, GEOCODING_KEYS.budget(NOW)]]);

    // An old replica's value: no status. No pause, no count.
    values.set(GEOCODING_KEYS.pause, "QUOTA 2026-11-15T00:00:00.000Z");

    expect(await read(NOW)).toMatchObject({
      pause: { reason: "QUOTA", status: null },
    });

    values.clear();

    expect(await read(NOW)).toEqual({ pause: null, used: 0 });
  });

  it("answers null when Redis does not", async () => {
    const read = redisReadHold({
      mget: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });

    expect(await read(NOW)).toBeNull();
  });
});
