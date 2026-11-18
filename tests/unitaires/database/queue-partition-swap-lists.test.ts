import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { registeredPartitions } from "@/shared/database/partitions";

/**
 * The queues' swap to partitioned tables (plano-escala F5-09) and its way
 * back name the same four queues as the partition registry, which keeps
 * them once swapped (F5-07): a queue the step forgot would stay plain for
 * good, and one the registry forgot would run out of partitions a week
 * after the swap, refusing every write. And the way back lives where the
 * release step never runs it: the runner reads only the top-level .sql
 * files of prisma/post-deploy.
 */
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const STEP = read("prisma/post-deploy/10-queue-partition-swap.sql");
const ROLLBACK = read("prisma/post-deploy/rollback/unpartition-queue.sql");

function queuesOf(sql: string): string[] {
  const block = /queues CONSTANT text\[\] := ARRAY\[([\s\S]*?)\];/.exec(sql);

  return [...(block?.[1] ?? "").matchAll(/'([a-z_]+)'/g)]
    .map((match) => match[1])
    .sort();
}

const REGISTERED = registeredPartitions({
  DRIVER_POSITION_RETENTION_DAYS: 90,
  DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
})
  .filter((table) => table.plainUntilSwap)
  .map((table) => table.table)
  .sort();

describe("the queues' swap to partitioned tables", () => {
  it("swaps, and puts back, the four queues the partition registry keeps", () => {
    expect(REGISTERED).toHaveLength(4);
    expect(queuesOf(STEP)).toEqual(REGISTERED);
    expect(queuesOf(ROLLBACK)).toEqual(REGISTERED);
  });

  it("asks for the capability and the contraction before it locks anything", () => {
    const ready = STEP.indexOf("trajetto_queue_swap_ready(");
    const contraction = STEP.indexOf("05-queue-contract.sql) ainda não tirou");
    const lock = STEP.indexOf("LOCK TABLE %I IN ACCESS EXCLUSIVE MODE");

    expect(ready).toBeGreaterThan(0);
    expect(contraction).toBeGreaterThan(ready);
    expect(lock).toBeGreaterThan(contraction);
  });

  it("keeps the way back out of the release step, behind an explicit choice of queue", () => {
    expect(ROLLBACK).toContain(
      "current_setting('trajetto.unpartition_queue', true)",
    );
    expect(ROLLBACK).toMatch(
      /RAISE EXCEPTION 'defina trajetto\.unpartition_queue/,
    );
    // Both files agree on the mark that keeps the swap away.
    expect(STEP).toContain("hold_marker CONSTANT text := 'trajetto:swap-hold'");
    expect(ROLLBACK).toContain(
      "hold_marker CONSTANT text := 'trajetto:swap-hold'",
    );
  });
});
