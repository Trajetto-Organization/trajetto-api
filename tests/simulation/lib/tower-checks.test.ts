import { describe, expect, it } from "vitest";

import {
  towerRouteCheck,
  type TowerRouteEvents,
  type TowerRouteExpectation,
} from "./tower-checks";

/**
 * Scene 11, the route half: a phone pinned to replica B drives its route, and
 * the tower — connected to replica A — must have received every routeEvent
 * that route produced (through the Socket.IO Redis adapter): the start, the
 * driver on the way, each stop settled with the status it ended in, the end
 * of the route (or the dispatcher's K11 closure) and, on the K12 route, the
 * plan change. The shapes are those of the run of 03/11/2026
 * (output/delivery-day-2replicas-speed8-run3.jsonl).
 *
 * Stop by stop, not by count: every stop whose "a caminho" or arrival the
 * API accepted from the phone (2xx) emitted its own frame on B, and a route
 * with seven `route-stop.on_the_way` frames out of eight is a board with one
 * dot that never turned "a caminho".
 */

function seen(
  counts: Record<string, number>,
  settled: Record<string, string[]> = {},
  onTheWay: string[] = Object.keys(settled),
): TowerRouteEvents {
  return {
    counts: new Map(Object.entries(counts)),
    settled: new Map(Object.entries(settled)),
    onTheWay: new Set(onTheWay),
  };
}

function expectation(
  overrides: Partial<TowerRouteExpectation> = {},
): TowerRouteExpectation {
  return {
    route: "R-PER",
    towerReplica: "A",
    phoneReplica: "B",
    stops: [
      { id: "stop-1", status: "COMPLETED" },
      { id: "stop-2", status: "FAILED" },
    ],
    accepted: { onTheWay: ["stop-1", "stop-2"], arrived: ["stop-1", "stop-2"] },
    closedWithPending: false,
    planChanged: false,
    ...overrides,
  };
}

/** Everything a two-stop route on replica B sends to the tower. */
const FULL_DAY = {
  "route.started": 1,
  "route-stop.on_the_way": 2,
  "route-stop.settled": 4,
  "route.completed": 1,
};

const BOTH_SETTLED = {
  "stop-1": ["ARRIVED", "COMPLETED"],
  "stop-2": ["ARRIVED", "FAILED"],
};

describe("towerRouteCheck", () => {
  it("passes when the tower received the whole route, and names the replicas", () => {
    const check = towerRouteCheck(expectation(), seen(FULL_DAY, BOTH_SETTLED));

    expect(check.ok).toBe(true);
    expect(check.check).toBe(
      "R-PER: eventos da rota chegaram à torre na réplica A (via B)",
    );
    expect(check.detail).toContain("route.started 1");
    expect(check.detail).toContain(
      "route-stop.on_the_way 2/2 paradas (2 quadros)",
    );
    expect(check.detail).toContain(
      "route-stop.settled 2/2 paradas, 2/2 chegadas (4 quadros)",
    );
    expect(check.detail).toContain("route.completed 1");
    expect(check.detail).not.toContain("faltou");
  });

  it("fails without route.started", () => {
    const { ["route.started"]: _started, ...rest } = FULL_DAY;
    const check = towerRouteCheck(expectation(), seen(rest, BOTH_SETTLED));

    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^faltou route\.started/);
  });

  it("fails without a single route-stop.on_the_way", () => {
    const check = towerRouteCheck(
      expectation(),
      seen({ ...FULL_DAY, "route-stop.on_the_way": 0 }, BOTH_SETTLED, []),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain(
      "faltou route-stop.on_the_way de stop-1, stop-2",
    );
    expect(check.detail).toContain("route-stop.on_the_way 0/2 paradas");
  });

  it("fails when one stop the phone announced on the way never reached the tower, even with other on_the_way frames", () => {
    // Two frames arrived, both about stop-1 (a second tap on the same stop):
    // the count says 2, but stop-2's dot never turned "a caminho".
    const check = towerRouteCheck(
      expectation(),
      seen(FULL_DAY, BOTH_SETTLED, ["stop-1"]),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^faltou route-stop\.on_the_way de stop-2 —/);
    expect(check.detail).toContain(
      "route-stop.on_the_way 1/2 paradas (2 quadros)",
    );
  });

  it("asks only for the stops whose on-the-way the API accepted", () => {
    // stop-2 was never announced (its call was refused, or the driver went
    // straight to the door): no frame of it is due.
    const check = towerRouteCheck(
      expectation({ accepted: { onTheWay: ["stop-1"], arrived: [] } }),
      seen(FULL_DAY, BOTH_SETTLED, ["stop-1"]),
    );

    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain("route-stop.on_the_way 1/1 paradas");
  });

  it("fails when the phone had no on-the-way accepted at all: nothing would be proven", () => {
    const check = towerRouteCheck(
      expectation({
        accepted: { onTheWay: [], arrived: ["stop-1", "stop-2"] },
      }),
      seen(FULL_DAY, BOTH_SETTLED),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain(
      "faltou route-stop.on_the_way (nenhum a caminho aceito pelo telefone)",
    );
  });

  it("fails when an arrival the API accepted never reached the tower as its settled ARRIVED", () => {
    // stop-2 ended FAILED on the tower, but the dot never showed "no local".
    const check = towerRouteCheck(
      expectation(),
      seen(FULL_DAY, {
        "stop-1": ["ARRIVED", "COMPLETED"],
        "stop-2": ["FAILED"],
      }),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(
      /^faltou route-stop\.settled de stop-2 ARRIVED —/,
    );
    expect(check.detail).toContain(
      "route-stop.settled 2/2 paradas, 1/2 chegadas (4 quadros)",
    );
  });

  it("fails when a resolved stop never reached the tower with the status it ended in", () => {
    // stop-2 arrived on the tower, but its FAILED never did.
    const check = towerRouteCheck(
      expectation(),
      seen(FULL_DAY, {
        "stop-1": ["ARRIVED", "COMPLETED"],
        "stop-2": ["ARRIVED"],
      }),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("route-stop.settled 1/2 paradas");
    expect(check.detail).toContain("stop-2 FAILED");
  });

  it("fails without route.completed", () => {
    const check = towerRouteCheck(
      expectation(),
      seen({ ...FULL_DAY, "route.completed": 0 }, BOTH_SETTLED),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("faltou route.completed");
  });

  it("accepts the K11 closure: the stops it cancelled have no stop frame, the closure is the route.completed", () => {
    const k11 = expectation({
      route: "R-MOE",
      stops: [
        { id: "stop-1", status: "COMPLETED" },
        { id: "stop-2", status: "CANCELLED" },
      ],
      accepted: { onTheWay: ["stop-1"], arrived: ["stop-1"] },
      closedWithPending: true,
    });
    const frames = {
      "route.started": 1,
      "route-stop.on_the_way": 1,
      "route-stop.settled": 2,
    };
    const settled = { "stop-1": ["ARRIVED", "COMPLETED"] };

    const closed = towerRouteCheck(
      k11,
      seen({ ...frames, "route.completed": 1 }, settled),
    );

    expect(closed.ok).toBe(true);
    expect(closed.detail).toContain("route-stop.settled 1/1 paradas");
    expect(closed.detail).toContain("route.completed 1 (encerramento K11)");

    const notClosed = towerRouteCheck(k11, seen(frames, settled));

    expect(notClosed.ok).toBe(false);
    expect(notClosed.detail).toContain(
      "faltou route.completed (encerramento K11)",
    );
  });

  it("requires the settled CANCELLED of a stop the dispatcher called off, on a route not closed by K11", () => {
    const check = towerRouteCheck(
      expectation({
        stops: [
          { id: "stop-1", status: "COMPLETED" },
          { id: "stop-2", status: "CANCELLED" },
        ],
        accepted: { onTheWay: ["stop-1"], arrived: ["stop-1"] },
      }),
      seen(FULL_DAY, { "stop-1": ["ARRIVED", "COMPLETED"] }),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("stop-2 CANCELLED");
  });

  it("requires route.stops_changed on the K12 route only", () => {
    const k12 = expectation({ planChanged: true });

    const without = towerRouteCheck(k12, seen(FULL_DAY, BOTH_SETTLED));

    expect(without.ok).toBe(false);
    expect(without.detail).toContain("faltou route.stops_changed (K12)");

    const withIt = towerRouteCheck(
      k12,
      seen({ ...FULL_DAY, "route.stops_changed": 1 }, BOTH_SETTLED),
    );

    expect(withIt.ok).toBe(true);
    expect(withIt.detail).toContain("route.stops_changed 1 (K12)");

    // Any other route passes without it.
    expect(
      towerRouteCheck(expectation(), seen(FULL_DAY, BOTH_SETTLED)).ok,
    ).toBe(true);
  });

  it("lists every gap at once", () => {
    const check = towerRouteCheck(
      expectation({ planChanged: true }),
      seen({}, {}),
    );

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("route.started");
    expect(check.detail).toContain("route-stop.on_the_way de stop-1, stop-2");
    expect(check.detail).toContain(
      // How each stop ended first, then the arrivals the tower never saw.
      "route-stop.settled de stop-1 COMPLETED, stop-2 FAILED, stop-1 ARRIVED, stop-2 ARRIVED",
    );
    expect(check.detail).toContain("0/2 paradas");
    expect(check.detail).toContain("route.completed");
    expect(check.detail).toContain("route.stops_changed (K12)");
  });
});
