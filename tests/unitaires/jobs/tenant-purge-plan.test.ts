import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { IDENTIFIER } from "@/shared/jobs/tenant-offboard/purge-batch";
import {
  HANDLED_ELSEWHERE,
  TENANT_PURGE_PLAN,
  isDeletingStep,
  type PurgeStep,
} from "@/shared/jobs/tenant-offboard/purge-plan";

/**
 * The purge plan of a company against the data model (plano-escala
 * F3-26a): prisma/schema.prisma as Prisma reads it — every model, its
 * table, its company column and its relations with their onDelete.
 *
 * A model added with the company's rows and forgotten in the plan would
 * outlive the company's purge: the plan must name every table that holds
 * the company (a `businessId`, or a foreign key into a table that does).
 * A child placed after its parent would make the parent's batch meet a
 * RESTRICT (the job fails on that step every night) or set off a cascade
 * of unknown size inside one batch: every foreign key between two tables
 * of the plan goes child first, unless the plan says the child rides the
 * parent's cascade. tests/E2E/tenant-offboard.test.ts checks the same
 * against the database's catalog, where the tables made by raw SQL live.
 */

interface Relation {
  child: string;
  parent: string;
  onDelete: string;
}

interface DataModel {
  /** Table name → whether it has a company column. */
  tables: Map<string, { company: string | null }>;
  relations: Relation[];
}

function readDataModel(text: string): DataModel {
  const models = [...text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const tableOf = new Map<string, string>();

  for (const [, name, body] of models) {
    const map = /@@map\("([^"]+)"\)/.exec(body);

    tableOf.set(name, map ? map[1] : name);
  }

  const tables: DataModel["tables"] = new Map();
  const relations: Relation[] = [];

  for (const [, name, body] of models) {
    const table = tableOf.get(name) as string;
    const company = /^\s+(businessId|business_id)\s+String/m.exec(body);

    tables.set(table, { company: company ? company[1] : null });

    for (const line of body.split("\n")) {
      const relation =
        /^\s+\w+\s+(\w+)\??\s+@relation\((?:"[^"]*",\s*)?(?:name:\s*"[^"]*",\s*)?fields:\s*\[[^\]]+\][^)]*\)/.exec(
          line,
        );

      if (!relation || !tableOf.has(relation[1])) continue;

      const onDelete = /onDelete:\s*(\w+)/.exec(line)?.[1] ?? "Default";

      relations.push({
        child: table,
        parent: tableOf.get(relation[1]) as string,
        onDelete,
      });
    }
  }

  return { tables, relations };
}

const model = readDataModel(
  readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8"),
);

/** The tables a plan deletes from, with the positions of their steps. */
function positions(plan: readonly PurgeStep[]): Map<string, number[]> {
  const found = new Map<string, number[]>();

  plan.forEach((step, index) => {
    if (!isDeletingStep(step)) return;

    for (const table of [step.table, ...(step.cascades ?? [])]) {
      found.set(table, [...(found.get(table) ?? []), index]);
    }
  });

  return found;
}

/** The tables that hold a company's rows, by column or by key. */
function companyTables(): Set<string> {
  const tables = new Set(
    [...model.tables]
      .filter(([table, { company }]) => company && table !== "business")
      .map(([table]) => table),
  );

  for (let grew = true; grew;) {
    grew = false;

    for (const { child, parent } of model.relations) {
      if (
        (tables.has(parent) || parent === "business") &&
        !tables.has(child) &&
        child !== "business"
      ) {
        tables.add(child);
        grew = true;
      }
    }
  }

  return tables;
}

function uncovered(plan: readonly PurgeStep[]): string[] {
  const named = new Set(plan.map((step) => step.table));

  for (const step of plan) {
    if (isDeletingStep(step)) {
      for (const table of step.cascades ?? []) named.add(table);
    }
  }

  return [...companyTables()]
    .filter((table) => !named.has(table) && !(table in HANDLED_ELSEWHERE))
    .sort();
}

function outOfOrder(plan: readonly PurgeStep[]): string[] {
  const at = positions(plan);
  // A child that rides a step's cascade, with the tables that step
  // deletes (its own and the rest of its cascade).
  const rides = new Map(
    plan.flatMap((step) =>
      isDeletingStep(step)
        ? (step.cascades ?? []).map(
            (child) => [child, [step.table, ...(step.cascades ?? [])]] as const,
          )
        : [],
    ),
  );
  const wrong: string[] = [];

  for (const { child, parent } of model.relations) {
    const childAt = at.get(child);
    const parentAt = at.get(parent);

    if (!childAt || !parentAt || child === parent) continue;
    if (rides.get(child)?.includes(parent)) continue;

    if (Math.max(...childAt) >= Math.min(...parentAt)) {
      wrong.push(`${child} → ${parent}`);
    }
  }

  return wrong.sort();
}

describe("the purge plan of a company", () => {
  it("reads the data model (the parser sees the models and their keys)", () => {
    expect(model.tables.get("delivery")).toEqual({ company: "businessId" });
    expect(model.tables.get("route_stop")).toEqual({ company: null });
    expect(model.relations).toContainEqual({
      child: "driver_pause",
      parent: "driver",
      onDelete: "Default",
    });
    expect(model.relations).toContainEqual({
      child: "delivery_item",
      parent: "delivery",
      onDelete: "Cascade",
    });
  });

  it("names every table that holds a company's rows", () => {
    expect(uncovered(TENANT_PURGE_PLAN)).toEqual([]);
  });

  it("deletes every child before its parent", () => {
    expect(outOfOrder(TENANT_PURGE_PLAN)).toEqual([]);
  });

  it("fails a plan that forgets a table or puts a child after its parent", () => {
    // Proof the two checks above can fail.
    const forgotten = TENANT_PURGE_PLAN.filter(
      (step) => step.table !== "delivery_item",
    );
    const reordered = [
      ...TENANT_PURGE_PLAN.filter((step) => step.table !== "driver_pause"),
      ...TENANT_PURGE_PLAN.filter((step) => step.table === "driver_pause"),
    ];

    expect(uncovered(forgotten)).toEqual(["delivery_item"]);
    expect(outOfOrder(reordered)).toContain("driver_pause → driver");
  });

  it("removes the dirty days after the deliveries, whose DELETE marks them", () => {
    // tenant_day_dirty has no foreign key (plano-escala F4-20): a trigger on
    // delivery writes a row for each day the purge's batches delete from,
    // so a step before the deliveries' would leave those rows behind.
    const at = (table: string) =>
      TENANT_PURGE_PLAN.findIndex(
        (step) => isDeletingStep(step) && step.table === table,
      );

    expect(at("delivery")).toBeGreaterThanOrEqual(0);
    expect(at("tenant_day_count")).toBeGreaterThanOrEqual(0);
    expect(at("tenant_day_dirty")).toBeGreaterThan(at("delivery"));
  });

  it("names only tables of the model, but the shells of a copy window", () => {
    const unknown = TENANT_PURGE_PLAN.filter(
      (step) =>
        !model.tables.has(step.table) &&
        !(isDeletingStep(step) && step.optional),
    ).map((step) => step.table);

    expect(unknown).toEqual([]);
  });

  it("lets a child ride its parent's batch only through a cascade", () => {
    for (const step of TENANT_PURGE_PLAN) {
      if (!isDeletingStep(step)) continue;

      for (const child of step.cascades ?? []) {
        const viaParent = model.relations.some(
          (relation) =>
            relation.child === child &&
            relation.onDelete === "Cascade" &&
            (relation.parent === step.table ||
              (step.cascades ?? []).includes(relation.parent)),
        );

        expect(viaParent, `${child} via ${step.table}`).toBe(true);
      }
    }
  });

  it("reads each step's company through a column the table has", () => {
    for (const step of TENANT_PURGE_PLAN) {
      if (step.kind === "children") {
        const parent = model.tables.get(step.parent);

        expect(parent?.company, `${step.table} ← ${step.parent}`).toBe(
          step.parentColumn ?? "businessId",
        );
        continue;
      }

      if (step.kind === "direct" && step.table === "pending_deletion") {
        continue;
      }

      const table = model.tables.get(step.table);

      if (table) expect(table.company, step.table).toBe(step.column);
    }
  });

  it("says what takes every row it leaves", () => {
    for (const step of TENANT_PURGE_PLAN) {
      if (step.kind === "expires") expect(step.by.length).toBeGreaterThan(10);
    }

    // The trail leaves by DROP unless TENANT_PURGE_TRAIL_NOW: both ways
    // are written down.
    for (const table of ["driver_position", "driver_position_v2"]) {
      const steps = TENANT_PURGE_PLAN.filter((step) => step.table === table);

      expect(steps.map((step) => step.kind).sort(), table).toEqual(
        expect.arrayContaining(["expires"]),
      );
      expect(
        steps.some((step) => isDeletingStep(step) && step.trail),
        table,
      ).toBe(true);
    }
  });

  it("names its tables and columns as plain identifiers", () => {
    for (const step of TENANT_PURGE_PLAN) {
      const names = [step.table, step.column];

      if (isDeletingStep(step)) {
        names.push(...(step.key ?? []), ...(step.cascades ?? []));

        for (const dependent of step.dependents ?? []) {
          names.push(dependent.table, dependent.column);
          if (dependent.from) names.push(dependent.from);
        }
      }

      if (step.kind === "children") {
        names.push(step.parent, step.parentKey ?? "id");
      }

      for (const name of names) expect(name).toMatch(IDENTIFIER);
    }
  });
});
