import "reflect-metadata";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { GetDashboardOverviewController } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-controller";
import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { GetDashboardTrendsController } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-controller";
import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";

/**
 * The dashboard's "Atualizar" reaches its snapshot (audit of 11/2026).
 *
 * The web sends `x-trajetto-refresh: 1` when the operator presses it, as
 * the Torre and the summary do; the controllers used to ignore it, so the
 * press brought back the company's copy of up to a minute. The use cases'
 * side (the two-second floor) is in dashboard-snapshot.test.ts.
 */
const execute = vi.fn(async (_input: unknown) => ({}));

afterEach(() => {
  execute.mockClear();
  container.clearInstances();
});

function request(headers: Record<string, string> = {}) {
  return {
    user: { id: "user-1", entitlements: null },
    query: { period: "7d" },
    headers,
  } as never;
}

const reply = {
  status: () => reply,
  send: () => reply,
} as never;

describe("the dashboard controllers", () => {
  it.each([
    ["overview", GetDashboardOverviewUseCase, GetDashboardOverviewController],
    ["trends", GetDashboardTrendsUseCase, GetDashboardTrendsController],
  ] as const)(
    "pass the refresh hint of the %s read to the use case",
    async (_name, useCase, Controller) => {
      container.registerInstance(useCase as never, { execute } as never);

      await new Controller().handle(request(), reply);
      await new Controller().handle(
        request({ "x-trajetto-refresh": "1" }),
        reply,
      );

      expect(execute.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ refresh: false }),
        expect.objectContaining({ refresh: true }),
      ]);
    },
  );
});

/**
 * The class, not the two cases: a use case that reads the dashboard's
 * snapshot through readDashboardNumbers must hand it the hint, or its
 * "Atualizar" is a no-op for up to DASHBOARD_SNAPSHOT_TTL_MS.
 */
describe("every read through the dashboard snapshot", () => {
  const MODULES = path.resolve(__dirname, "../../../src/modules");

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);

      if (statSync(full).isDirectory()) return sourceFiles(full);

      return full.endsWith(".ts") ? [full] : [];
    });
  }

  it("passes `refresh` along", () => {
    const readers = sourceFiles(MODULES).filter(
      (file) =>
        !file.endsWith("dashboard-snapshot.ts") &&
        readFileSync(file, "utf8").includes("readDashboardNumbers("),
    );

    const offenders = readers
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        const calls = source.split("readDashboardNumbers(").slice(1);

        return calls.some((call) => !/^[^;]*\brefresh\b[^;]*;/.test(call));
      })
      .map((file) => path.relative(MODULES, file).replace(/\\/g, "/"));

    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
