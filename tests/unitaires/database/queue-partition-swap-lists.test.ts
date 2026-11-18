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
  .filter((table) => table.plainUntilSwap && table.grain === "day")
  .map((table) => table.table)
  .sort();

const BELL_STEP = read("prisma/post-deploy/20-notification-partition-swap.sql");
const PARTITIONS_SQL = read("infra/sql/10-partitions.sql");

describe("the queues' swap to partitioned tables", () => {
  it("swaps, and puts back, the four queues the partition registry keeps", () => {
    expect(REGISTERED).toHaveLength(4);
    expect(queuesOf(STEP)).toEqual(REGISTERED);
    // The way back serves the bell's swap too (F5-15).
    expect(queuesOf(ROLLBACK)).toEqual([...REGISTERED, "notification"].sort());
  });

  it("swaps the bell by month in a step of its own, owned like the queues", () => {
    // F5-15: the registry keeps it once swapped, and infra/sql makes
    // trajetto_partitions its owner; a bell the step swapped and the job
    // did not know would run out of months.
    expect(queuesOf(BELL_STEP)).toEqual(["notification"]);
    expect(BELL_STEP).toContain(
      "trajetto_capability_ready('notification-partition-agnostic-v1'",
    );
    expect(BELL_STEP).toContain(
      "07-notification-contract.sql) ainda não tirou",
    );
    expect(BELL_STEP).toContain("make_interval(months => day_offset)");
    expect(PARTITIONS_SQL).toMatch(
      /'webhook_delivery',\s+'notification'\s+\];/,
    );
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
