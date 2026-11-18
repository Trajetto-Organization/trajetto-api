import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

/**
 * The process's memory budget, checked at boot (plano-escala U-15).
 *
 * The container has one ceiling — the Application's Memory, the cgroup's
 * memory.max — and several heaps live under it: the main one
 * (--max-old-space-size), one per spreadsheet thread
 * (SPREADSHEET_READS_PER_PROCESS × SPREADSHEET_WORKER_MAX_OLD_MB, F3-23b),
 * one per CPU pool thread (F3-29, none yet), and what V8 and the native
 * libraries hold outside every heap (NATIVE_RESERVE_MB). Moving the
 * spreadsheet read to a thread gave it a heap of its own ON TOP of the main
 * one: with the 768 MB heap of today in a 1 GiB container, the first big
 * spreadsheet would take the process past its ceiling, and the kernel kills
 * the whole container — not the thread, the replica.
 *
 *   heap + reads × spreadsheet + cpu threads × cpu + native ≤ memory.max
 *
 * MEMORY_BUDGET_MODE says what a sum that does not fit does:
 *  - `warn` (the default of this release): a pt-BR line in the log,
 *    `memory_budget_ok=false` on /health/metrics and in the process's
 *    ops_sample row, and the memory-budget alert. Refusing the boot while
 *    the Environments still carry the values of before would take
 *    production down on the deploy that brings the check;
 *  - `enforce` (the default from wave 20, once section 3's values are on
 *    both environments): the boot is refused.
 *
 * Without a readable cgroup (a developer's machine, a container with no
 * ceiling) there is nothing to compare with, and the check is skipped with
 * a warning instead of guessed.
 *
 * Pure but for the defaults of `system`, which read the cgroup files, the
 * flags and V8; the env schema reads the defaults from here.
 */

/** What V8 and the native libraries hold outside every heap. */
const NATIVE_RESERVE_DEFAULT_MB = 150;

/** One CPU pool thread's heap (F3-29), when the pool exists. */
const CPU_POOL_THREAD_DEFAULT_MAX_OLD_MB = 64;

/**
 * The spreadsheet thread's heap when nobody set it: the room the budget
 * leaves, per read, between these bounds. The floor is the plan's
 * production value and not the variable's own 64: derived lower, the
 * production of today (heap 768 in 1 GiB) would start refusing big
 * spreadsheets it reads now, before the owner moves NODE_OPTIONS to 576;
 * kept at 256, the sum does not fit and the boot says so instead.
 */
const SPREADSHEET_DERIVED_MIN_MB = 256;
const SPREADSHEET_DERIVED_MAX_MB = 768;

const MEMORY_BUDGET_MODES = ["warn", "enforce"] as const;

type MemoryBudgetMode = (typeof MEMORY_BUDGET_MODES)[number];

const MIB = 1024 * 1024;

/**
 * At or above this, a cgroup v1 limit means "no limit" (the kernel writes
 * the largest page-aligned 64-bit value).
 */
const UNLIMITED_BYTES = 2 ** 60;

/** The cgroup v2 file, then the v1 one. */
const CGROUP_FILES = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
];

/** What the budget reads of the machine; each part replaceable in tests. */
interface MemorySystem {
  readFile: (path: string) => string;

  /** NODE_OPTIONS, where the image's Environment sets the heap. */
  nodeOptions: string | undefined;

  /** The process's own flags (they win over NODE_OPTIONS). */
  execArgv: readonly string[];

  /** V8's heap limit, the fallback when no flag sets the heap. */
  heapSizeLimitBytes: () => number;
}

const realSystem: MemorySystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  nodeOptions: process.env.NODE_OPTIONS,
  execArgv: process.execArgv,
  heapSizeLimitBytes: () => getHeapStatistics().heap_size_limit,
};

/** The container's ceiling in MiB, or why there is none to read. */
function cgroupMemoryMaxMb(
  readFile: MemorySystem["readFile"],
): { limitMb: number } | { limitMb: null; reason: string } {
  for (const file of CGROUP_FILES) {
    let text: string;

    try {
      text = readFile(file).trim();
    } catch {
      continue;
    }

    if (text === "max") {
      return {
        limitMb: null,
        reason: "o contêiner não tem teto de memória (memory.max = max)",
      };
    }

    const bytes = Number(text);

    if (!Number.isFinite(bytes) || bytes <= 0) continue;

    if (bytes >= UNLIMITED_BYTES) {
      return {
        limitMb: null,
        reason: "o contêiner não tem teto de memória (cgroup v1 sem limite)",
      };
    }

    return { limitMb: Math.floor(bytes / MIB) };
  }

  return {
    limitMb: null,
    reason: "nenhum cgroup legível (/sys/fs/cgroup/memory.max)",
  };
}

/**
 * The main heap's ceiling in MB: the last --max-old-space-size, the
 * process's own flags after NODE_OPTIONS (Node reads them in that order);
 * V8's limit when no flag sets it.
 */
function mainHeapMb(system: MemorySystem): {
  heapMb: number;
  source: "flag" | "v8";
} {
  const flag = /--max[-_]old[-_]space[-_]size[=\s]+(\d+)/g;
  let found: number | null = null;

  for (const text of [system.nodeOptions ?? "", system.execArgv.join(" ")]) {
    for (const match of text.matchAll(flag)) found = Number(match[1]);
  }

  if (found !== null && found > 0) return { heapMb: found, source: "flag" };

  return {
    heapMb: Math.round(system.heapSizeLimitBytes() / MIB),
    source: "v8",
  };
}

/**
 * The spreadsheet thread's heap: the variable when set; else the room the
 * budget leaves per read, between 256 and 768 (256 without a ceiling to
 * divide, or without a read to give it to).
 */
function spreadsheetMaxOldMb(input: {
  explicitMb: number | undefined;
  reads: number;
  limitMb: number | null;
  heapMb: number;
  cpuPoolMb: number;
  nativeMb: number;
}): number {
  if (input.explicitMb !== undefined) return input.explicitMb;

  if (input.reads <= 0 || input.limitMb === null) {
    return SPREADSHEET_DERIVED_MIN_MB;
  }

  const room = Math.floor(
    (input.limitMb - input.heapMb - input.cpuPoolMb - input.nativeMb) /
      input.reads,
  );

  return Math.min(
    SPREADSHEET_DERIVED_MAX_MB,
    Math.max(SPREADSHEET_DERIVED_MIN_MB, room),
  );
}

/** The environment the budget reads (the parsed env satisfies it). */
interface MemoryBudgetEnv {
  SPREADSHEET_READS_PER_PROCESS: number;
  SPREADSHEET_WORKER_MAX_OLD_MB?: number;
  NATIVE_RESERVE_MB: number;
  MEMORY_BUDGET_MODE: MemoryBudgetMode;
}

interface MemoryBudget {
  mode: MemoryBudgetMode;

  /** False when there was no ceiling to compare with (see `reason`). */
  checked: boolean;

  /** Null when not checked. */
  ok: boolean | null;

  limitMb: number | null;
  totalMb: number;

  parts: {
    heapMb: number;
    heapSource: "flag" | "v8";
    spreadsheetReads: number;
    spreadsheetMaxOldMb: number;
    cpuPoolThreads: number;
    cpuPoolThreadMaxOldMb: number;
    nativeMb: number;
  };

  /** Why it was not checked; null when it was. */
  reason: string | null;
}

/** The sum and the verdict for this process's settings. */
function evaluateMemoryBudget(
  env: MemoryBudgetEnv,
  system: MemorySystem = realSystem,
  cpuPool: { threads: number; maxOldMb: number } = {
    // The CPU pool of F3-29 does not exist yet: nothing to count.
    threads: 0,
    maxOldMb: CPU_POOL_THREAD_DEFAULT_MAX_OLD_MB,
  },
): MemoryBudget {
  const ceiling = cgroupMemoryMaxMb(system.readFile);
  const { heapMb, source } = mainHeapMb(system);
  const cpuPoolMb = cpuPool.threads * cpuPool.maxOldMb;
  const reads = env.SPREADSHEET_READS_PER_PROCESS;

  const sheetMb = spreadsheetMaxOldMb({
    explicitMb: env.SPREADSHEET_WORKER_MAX_OLD_MB,
    reads,
    limitMb: ceiling.limitMb,
    heapMb,
    cpuPoolMb,
    nativeMb: env.NATIVE_RESERVE_MB,
  });

  const totalMb = heapMb + reads * sheetMb + cpuPoolMb + env.NATIVE_RESERVE_MB;

  return {
    mode: env.MEMORY_BUDGET_MODE,
    checked: ceiling.limitMb !== null,
    ok: ceiling.limitMb === null ? null : totalMb <= ceiling.limitMb,
    limitMb: ceiling.limitMb,
    totalMb,
    parts: {
      heapMb,
      heapSource: source,
      spreadsheetReads: reads,
      spreadsheetMaxOldMb: sheetMb,
      cpuPoolThreads: cpuPool.threads,
      cpuPoolThreadMaxOldMb: cpuPool.maxOldMb,
      nativeMb: env.NATIVE_RESERVE_MB,
    },
    reason: "reason" in ceiling ? ceiling.reason : null,
  };
}

/** The pt-BR sentence of a sum that does not fit. */
function memoryBudgetMessage(budget: MemoryBudget): string {
  const { parts } = budget;

  return (
    `O orçamento de memória do processo não fecha: heap ${parts.heapMb} MiB ` +
    `+ ${parts.spreadsheetReads} × ${parts.spreadsheetMaxOldMb} MiB da ` +
    `planilha + ${parts.cpuPoolThreads} × ${parts.cpuPoolThreadMaxOldMb} ` +
    `MiB do pool de CPU + ${parts.nativeMb} MiB de reserva nativa = ` +
    `${budget.totalMb} MiB, acima do teto de ${budget.limitMb} MiB do ` +
    "contêiner. Baixe o --max-old-space-size do NODE_OPTIONS ou o " +
    "SPREADSHEET_WORKER_MAX_OLD_MB, ou suba o Memory da Application " +
    "(docs/runbooks/memory-budget.md)."
  );
}

interface BootLog {
  info: (fields: object, message: string) => void;
  warn: (fields: object, message: string) => void;
}

/**
 * The boot's step: logs the budget, and refuses the boot on a sum that
 * does not fit when MEMORY_BUDGET_MODE=enforce. Returns the budget.
 */
function checkMemoryBudgetAtBoot(
  env: MemoryBudgetEnv,
  log: BootLog,
  { deployed, system }: { deployed: boolean; system?: MemorySystem } = {
    deployed: true,
  },
): MemoryBudget {
  const budget = evaluateMemoryBudget(env, system);
  const fields = { memoryBudget: budget };

  if (!budget.checked) {
    // A deployment without a ceiling to read is worth a look; a
    // developer's machine never has one. Called on the logger, never
    // detached from it: pino's methods need it as `this`.
    const line = `memory budget not checked: ${budget.reason}`;

    if (deployed) log.warn(fields, line);
    else log.info(fields, line);

    return budget;
  }

  if (budget.ok) {
    log.info(fields, "memory budget fits");

    return budget;
  }

  const message = memoryBudgetMessage(budget);

  if (budget.mode === "enforce") throw new Error(message);

  log.warn({ ...fields, detail: message }, "memory budget does not fit");

  return budget;
}

let current: MemoryBudget | null = null;

/**
 * This process's budget, evaluated once: the boot's verdict, the
 * spreadsheet thread's ceiling and /health/metrics all read the same one.
 */
function processMemoryBudget(env: MemoryBudgetEnv): MemoryBudget {
  current ??= evaluateMemoryBudget(env);

  return current;
}

/** Records the boot's own evaluation as this process's budget. */
function rememberMemoryBudget(budget: MemoryBudget): void {
  current = budget;
}

export {
  CPU_POOL_THREAD_DEFAULT_MAX_OLD_MB,
  MEMORY_BUDGET_MODES,
  NATIVE_RESERVE_DEFAULT_MB,
  SPREADSHEET_DERIVED_MAX_MB,
  SPREADSHEET_DERIVED_MIN_MB,
  cgroupMemoryMaxMb,
  checkMemoryBudgetAtBoot,
  evaluateMemoryBudget,
  mainHeapMb,
  memoryBudgetMessage,
  processMemoryBudget,
  rememberMemoryBudget,
  spreadsheetMaxOldMb,
};
export type { MemoryBudget, MemoryBudgetEnv, MemoryBudgetMode, MemorySystem };
