import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  DEFAULT_ALERT_THRESHOLDS,
  collectAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  cgroupMemoryMaxMb,
  checkMemoryBudgetAtBoot,
  evaluateMemoryBudget,
  mainHeapMb,
  spreadsheetMaxOldMb,
  type MemoryBudgetEnv,
  type MemorySystem,
} from "@/shared/lifecycle/memory-budget";

/**
 * The process's memory budget, checked at boot (plano-escala U-15).
 *
 * Reading the spreadsheet on a worker thread (F3-23b) gave it a heap of
 * its own, ON TOP of the main one: with the 768 MB heap of today in a
 * 1 GiB container, the first big spreadsheet takes the process past its
 * ceiling and the kernel kills the whole replica. The boot now sums the
 * heaps and the native reserve against the cgroup's memory.max.
 *
 * What this pins:
 *  - the table of the plan: 1024 of ceiling, heap 768 and spreadsheet 256
 *    warn in `warn` and refuse in `enforce`; heap 576 fits;
 *  - the ceiling read from cgroup v2 and v1, and a check skipped (never
 *    guessed) without one;
 *  - the heap read from NODE_OPTIONS and the process's own flags;
 *  - the spreadsheet thread's ceiling derived from the room left;
 *  - a process that does not fit pages through the ops heartbeat.
 */

const MIB = 1024 * 1024;

/** A container of `limitMb` and a process started with `heapMb`. */
function system({
  limitMb,
  heapMb,
  cgroup = "v2",
}: {
  limitMb: number | "max" | null;
  heapMb?: number;
  cgroup?: "v1" | "v2";
}): MemorySystem {
  const file =
    cgroup === "v2"
      ? "/sys/fs/cgroup/memory.max"
      : "/sys/fs/cgroup/memory/memory.limit_in_bytes";

  return {
    readFile: (path) => {
      if (limitMb === null || path !== file) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      return limitMb === "max" ? "max\n" : `${limitMb * MIB}\n`;
    },
    nodeOptions:
      heapMb === undefined ? undefined : `--max-old-space-size=${heapMb}`,
    execArgv: [],
    heapSizeLimitBytes: () => 2_096 * MIB,
  };
}

function budgetEnv(overrides: Partial<MemoryBudgetEnv> = {}): MemoryBudgetEnv {
  return {
    SPREADSHEET_READS_PER_PROCESS: 1,
    SPREADSHEET_WORKER_MAX_OLD_MB: 256,
    NATIVE_RESERVE_MB: 150,
    MEMORY_BUDGET_MODE: "warn",
    ...overrides,
  };
}

function bootLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("the plan's table", () => {
  it("warns in warn with 1024 of ceiling, heap 768 and spreadsheet 256", () => {
    const log = bootLog();

    const budget = checkMemoryBudgetAtBoot(budgetEnv(), log, {
      deployed: true,
      system: system({ limitMb: 1_024, heapMb: 768 }),
    });

    expect(budget).toMatchObject({
      checked: true,
      ok: false,
      limitMb: 1_024,
      totalMb: 768 + 256 + 150,
    });

    expect(log.warn).toHaveBeenCalledTimes(1);

    const [fields, line] = log.warn.mock.calls[0];

    expect(line).toBe("memory budget does not fit");
    expect((fields as { detail: string }).detail).toContain(
      "O orçamento de memória do processo não fecha: heap 768 MiB + 1 × 256 MiB da planilha",
    );
    expect((fields as { detail: string }).detail).toContain(
      "= 1174 MiB, acima do teto de 1024 MiB do contêiner",
    );
  });

  it("refuses the boot in enforce with the same numbers", () => {
    expect(() =>
      checkMemoryBudgetAtBoot(
        budgetEnv({ MEMORY_BUDGET_MODE: "enforce" }),
        bootLog(),
        { deployed: true, system: system({ limitMb: 1_024, heapMb: 768 }) },
      ),
    ).toThrow(/não fecha: heap 768 MiB .* acima do teto de 1024 MiB/);
  });

  it("fits with heap 576, in either mode", () => {
    for (const mode of ["warn", "enforce"] as const) {
      const log = bootLog();

      const budget = checkMemoryBudgetAtBoot(
        budgetEnv({ MEMORY_BUDGET_MODE: mode }),
        log,
        { deployed: true, system: system({ limitMb: 1_024, heapMb: 576 }) },
      );

      expect(budget).toMatchObject({ ok: true, totalMb: 982 });
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.anything(),
        "memory budget fits",
      );
    }
  });

  it("counts no spreadsheet thread where none reads", () => {
    // The worker of the plan: heap 256 in 448 MiB, SPREADSHEET_READS_PER_PROCESS=0.
    const budget = evaluateMemoryBudget(
      budgetEnv({
        SPREADSHEET_READS_PER_PROCESS: 0,
        SPREADSHEET_WORKER_MAX_OLD_MB: undefined,
      }),
      system({ limitMb: 448, heapMb: 256 }),
    );

    expect(budget).toMatchObject({ ok: true, totalMb: 256 + 150 });
  });

  it("counts every CPU pool thread at its ceiling (F3-29)", () => {
    // The api of section 3: staging heap 288 in 512 MiB with one thread,
    // production heap 448 in 768 MiB with two; no spreadsheet thread.
    const staging = evaluateMemoryBudget(
      budgetEnv({
        SPREADSHEET_READS_PER_PROCESS: 0,
        CPU_POOL_THREADS: 1,
        CPU_POOL_THREAD_MAX_OLD_MB: 64,
      }),
      system({ limitMb: 512, heapMb: 288 }),
    );
    const production = evaluateMemoryBudget(
      budgetEnv({
        SPREADSHEET_READS_PER_PROCESS: 0,
        CPU_POOL_THREADS: 2,
        CPU_POOL_THREAD_MAX_OLD_MB: 64,
      }),
      system({ limitMb: 768, heapMb: 448 }),
    );

    expect(staging).toMatchObject({ ok: true, totalMb: 288 + 64 + 150 });
    expect(staging.parts).toMatchObject({
      cpuPoolThreads: 1,
      cpuPoolThreadMaxOldMb: 64,
    });
    expect(production).toMatchObject({
      ok: true,
      totalMb: 448 + 2 * 64 + 150,
    });

    // Eight threads of 64 do not fit the staging api.
    expect(
      evaluateMemoryBudget(
        budgetEnv({ SPREADSHEET_READS_PER_PROCESS: 0, CPU_POOL_THREADS: 8 }),
        system({ limitMb: 512, heapMb: 288 }),
      ),
    ).toMatchObject({ ok: false, totalMb: 288 + 8 * 64 + 150 });
  });
});

describe("the boot", () => {
  it("checks the budget before any step of the startup, so enforce stops it first", () => {
    const server = readFileSync(
      resolve(process.cwd(), "src/server.ts"),
      "utf8",
    );
    const check = server.indexOf("checkMemoryBudgetAtBoot(env, log");
    const startup = server.indexOf("await runStartup(");

    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(startup);
  });
});

describe("the container's ceiling", () => {
  it("is read from cgroup v2, then v1", () => {
    expect(cgroupMemoryMaxMb(system({ limitMb: 1_024 }).readFile)).toEqual({
      limitMb: 1_024,
    });
    expect(
      cgroupMemoryMaxMb(system({ limitMb: 768, cgroup: "v1" }).readFile),
    ).toEqual({ limitMb: 768 });
  });

  it("skips the check, with the reason, without a ceiling to read", () => {
    for (const limitMb of ["max", null] as const) {
      const log = bootLog();

      const budget = checkMemoryBudgetAtBoot(
        budgetEnv({ MEMORY_BUDGET_MODE: "enforce" }),
        log,
        { deployed: true, system: system({ limitMb, heapMb: 4_096 }) },
      );

      // Never guessed, never refused: there is nothing to compare with.
      expect(budget).toMatchObject({ checked: false, ok: null });
      expect(budget.reason).toBeTruthy();
      expect(log.warn).toHaveBeenCalledWith(
        expect.anything(),
        `memory budget not checked: ${budget.reason}`,
      );
    }

    // A cgroup v1 without a limit writes the largest page-aligned value.
    expect(cgroupMemoryMaxMb(() => "9223372036854771712\n").limitMb).toBeNull();
  });

  it("says it at info on a developer's machine, which never has one", () => {
    const log = bootLog();

    checkMemoryBudgetAtBoot(budgetEnv(), log, {
      deployed: false,
      system: system({ limitMb: null, heapMb: 768 }),
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe("the main heap", () => {
  it("is the last --max-old-space-size, the process's flags after NODE_OPTIONS", () => {
    const base = system({ limitMb: 1_024 });

    expect(
      mainHeapMb({ ...base, nodeOptions: "--max-old-space-size=576" }),
    ).toEqual({ heapMb: 576, source: "flag" });
    expect(
      mainHeapMb({
        ...base,
        nodeOptions: "--enable-source-maps --max_old_space_size=512",
        execArgv: ["--max-old-space-size=320"],
      }),
    ).toEqual({ heapMb: 320, source: "flag" });
  });

  it("is V8's own limit without the flag", () => {
    expect(mainHeapMb(system({ limitMb: 1_024 }))).toEqual({
      heapMb: 2_096,
      source: "v8",
    });
  });
});

describe("the spreadsheet thread's ceiling without the variable", () => {
  const derive = (limitMb: number | null, heapMb: number, reads = 1) =>
    spreadsheetMaxOldMb({
      explicitMb: undefined,
      reads,
      limitMb,
      heapMb,
      cpuPoolMb: 0,
      nativeMb: 150,
    });

  it("is the room the budget leaves per read, between 256 and 768", () => {
    // Production after the owner's change: 1024 − 576 − 150.
    expect(derive(1_024, 576)).toBe(298);
    expect(derive(1_024, 512, 2)).toBe(256);
    expect(derive(4_096, 512)).toBe(768);
  });

  it("does not shrink below 256 for today's heap, and the sum then warns", () => {
    // 1024 − 768 − 150 = 106 would refuse big spreadsheets that read today.
    expect(derive(1_024, 768)).toBe(256);

    const budget = evaluateMemoryBudget(
      budgetEnv({ SPREADSHEET_WORKER_MAX_OLD_MB: undefined }),
      system({ limitMb: 1_024, heapMb: 768 }),
    );

    expect(budget).toMatchObject({ ok: false, totalMb: 1_174 });
    expect(budget.parts.spreadsheetMaxOldMb).toBe(256);
  });

  it("is 256 without a ceiling, and the variable when it is set", () => {
    expect(derive(null, 768)).toBe(256);
    expect(
      spreadsheetMaxOldMb({
        explicitMb: 96,
        reads: 1,
        limitMb: 1_024,
        heapMb: 320,
        cpuPoolMb: 0,
        nativeMb: 150,
      }),
    ).toBe(96);
  });
});

describe("the variables", () => {
  const BASE_ENV = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  it("default to warn and a reserve of 150, and refuse a mode nobody knows", () => {
    const parsed = envSchema.safeParse({
      ...BASE_ENV,
      NATIVE_RESERVE_MB: "",
      MEMORY_BUDGET_MODE: "",
    });

    if (!parsed.success) throw parsed.error;

    expect(parsed.data).toMatchObject({
      NATIVE_RESERVE_MB: 150,
      MEMORY_BUDGET_MODE: "warn",
    });

    expect(
      envSchema.safeParse({ ...BASE_ENV, MEMORY_BUDGET_MODE: "refuse" })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...BASE_ENV, NATIVE_RESERVE_MB: "-1" }).success,
    ).toBe(false);
  });
});

describe("a process that does not fit", () => {
  it("pages through the ops heartbeat, naming the replica", () => {
    const snapshot = {
      now: new Date(),
      outboxEligibleLagSec: null,
      deliveryEligibleLagSec: { internal: null, external: null },
      webhookDueLagSec: null,
      aiEligibleLagSec: null,
      deliveryFailures: [],
      aiCredentialFailures: 0,
      cronJobs: [],
      partitionRunwayOk: true,
      partitionRunwayDays: null,
      stuckWorkers: [],
      connectionUsagePercent: 0,
      redisOk: true,
      memoryBudgets: [{ replica: "api-1", totalMb: 1_174, limitMb: 1_024 }],
      collectionErrors: [],
    } satisfies OperationalSnapshot;

    const alerts = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    }).filter((alert) => alert.code === "memory-budget");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("api-1");
    expect(alerts[0].message).toContain("1174 MiB");
    expect(alerts[0].message).toContain("1024 MiB");
  });
});
