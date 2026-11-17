import { describe, expect, it } from "vitest";

import { createHttpMetrics } from "@/shared/health/http-metrics";
import { createPositionsGate } from "@/shared/http/load-shedding";
import {
  POSITIONS_SHED_MODES,
  positionsAdoption,
  positionsMayBeShed,
  type PositionsAdoption,
  type PositionsShedMode,
} from "@/shared/http/shed-classes";

/**
 * The positions' gate (plano-escala F2-25).
 *
 * The GPS flush is the one deferrable route whose refusal can backfire: an
 * app build without back-off answers a 503 by sending the same batch again
 * at once, so refusing the positions of a fleet still half on old builds
 * multiplies the traffic it meant to shed. With SHED_POSITIONS_MODE=auto
 * (the default) the gate opens only while 90% of the replica's POSTs of
 * the last ten minutes came from contract 8, the build that waits
 * Retry-After. The acceptance of the plan: with half the fleet on the old
 * contract, it never refuses.
 */

const adoption = (adopted: number, total: number): PositionsAdoption => ({
  total,
  adopted,
  share: total > 0 ? adopted / total : null,
});

describe("the adoption", () => {
  it("counts only contract 8 and above as the build that backs off", () => {
    expect(positionsAdoption({ "6": 2, "7": 3, "8": 4, "9": 1 })).toEqual({
      total: 10,
      adopted: 5,
      share: 0.5,
    });
  });

  it("counts a missing or unkept contract as old, never as new", () => {
    expect(positionsAdoption({ unknown: 1, other: 1, "8": 8 })).toEqual({
      total: 10,
      adopted: 8,
      share: 0.8,
    });
  });

  it("says nothing with no POST in the window", () => {
    expect(positionsAdoption({})).toEqual({
      total: 0,
      adopted: 0,
      share: null,
    });
  });
});

describe("the gate", () => {
  it.each<[PositionsShedMode, PositionsAdoption, boolean]>([
    ["auto", adoption(0, 0), false],
    ["auto", adoption(5, 10), false],
    ["auto", adoption(899, 1_000), false],
    ["auto", adoption(900, 1_000), true],
    ["auto", adoption(10, 10), true],
    ["observe", adoption(10, 10), false],
    ["observe", adoption(0, 0), false],
    ["enforce", adoption(0, 0), true],
    ["enforce", adoption(5, 10), true],
  ])("%s with %o is open: %s", (mode, measured, open) => {
    expect(positionsMayBeShed(mode, measured)).toBe(open);
  });

  it("knows exactly these modes", () => {
    expect([...POSITIONS_SHED_MODES]).toEqual(["auto", "observe", "enforce"]);
  });
});

describe("the gate over the replica's window", () => {
  function windowWith(contracts: Array<number | undefined>) {
    const metrics = createHttpMetrics({ now: () => 0 });

    for (const contract of contracts) metrics.recordPositionsContract(contract);

    return metrics;
  }

  it("stays shut with half the fleet on the old contract", () => {
    const metrics = windowWith([7, 7, 7, 7, 7, 8, 8, 8, 8, 8]);
    const gate = createPositionsGate({
      now: () => 0,
      mode: () => "auto",
      contracts: () => metrics.positionsContracts().by_contract,
    });

    expect(gate()).toEqual({
      mode: "auto",
      total: 10,
      adopted: 5,
      share: 0.5,
      open: false,
    });
  });

  it("opens with nine in ten on contract 8, and rereads at most once a second", () => {
    let clock = 0;
    const metrics = windowWith([7, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
    const gate = createPositionsGate({
      now: () => clock,
      mode: () => "auto",
      contracts: () => metrics.positionsContracts().by_contract,
    });

    expect(gate()).toMatchObject({ share: 0.9, open: true });

    // Old builds arrive: the same answer within the second, then the new.
    for (let index = 0; index < 10; index += 1) {
      metrics.recordPositionsContract(undefined);
    }

    clock = 999;
    expect(gate().open).toBe(true);

    clock = 1_000;
    expect(gate()).toMatchObject({ total: 20, adopted: 9, open: false });
  });

  it("follows a change of mode at once", () => {
    let mode: PositionsShedMode = "auto";
    const gate = createPositionsGate({
      now: () => 0,
      mode: () => mode,
      contracts: () => ({}),
    });

    expect(gate().open).toBe(false);

    mode = "enforce";
    expect(gate()).toMatchObject({ mode: "enforce", open: true });
  });
});
