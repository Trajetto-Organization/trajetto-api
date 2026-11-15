import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import cron from "node-cron";

import { registerCronJobs } from "@/jobs/cron";
import {
  DEFAULT_PARTIAL_RETRY_WINDOW_UTC,
  DEFAULT_PURGE_RUN_BUDGET_MS,
} from "@/shared/services/cron-limits";
import {
  CATCH_UP_SCHEDULE,
  CronJobDefinition,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * What the replicas actually schedule.
 *
 * A purge that exists as a file but is never registered purges nothing, and
 * no test of the handler would notice: the handler is correct, it just never
 * runs. The webhook ledger was in exactly that state in spirit — its replay
 * window was documented as "respected by the purge" while no purge existed.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function registered(): CronJobDefinition[] {
  const jobs: CronJobDefinition[] = [];

  vi.spyOn(
    CronSchedulerService.getInstance(),
    "registerJob",
  ).mockImplementation((definition: CronJobDefinition) => {
    jobs.push(definition);
  });

  registerCronJobs();

  return jobs;
}

describe("the cron registry", () => {
  it("schedules the purge of the webhook ledger", () => {
    const job = registered().find(
      (entry) => entry.name === "cleanup-webhook-deliveries",
    );

    expect(job).toBeDefined();
    expect(cron.validate(job!.schedule)).toBe(true);
  });

  it("gives every job a unique name and a valid schedule", () => {
    const jobs = registered();

    // A duplicate name is silently ignored by the scheduler, so a copy-paste
    // would drop the second job without a word.
    expect(new Set(jobs.map((job) => job.name)).size).toBe(jobs.length);

    for (const job of jobs) {
      expect(cron.validate(job.schedule), job.name).toBe(true);
    }
  });
});

/**
 * The schedule map (docs/operacao/jobs.md, plano-escala F1-21 and D28).
 *
 * The nightly purges, the Dokploy backup, the PITR backups, the restore
 * drill and the load windows were each placed on their own, and the heavy
 * ones overlapped: a full backup on top of the history window, a load run
 * on top of the drill. The map is now one table, and this reads it: the
 * code's schedules must be the table's, and no two heavy entries may share
 * a minute on any day.
 */
interface MapRow {
  entry: string;
  where: string;
  schedule: string | null;
  days: string;
  window: { start: number; end: number } | null;
  heavy: boolean;
}

const JOBS_MAP = resolve(process.cwd(), "docs/operacao/jobs.md");

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);

  return hours * 60 + minutes;
}

/** "03:17–03:22" (or with a hyphen): minutes after 00:00 UTC, end excluded. */
function parseWindow(text: string): { start: number; end: number } | null {
  const match = text.match(/^(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})$/);

  if (!match) return null;

  return { start: minutesOf(match[1]), end: minutesOf(match[2]) };
}

function mapRows(text: string): MapRow[] {
  const section = text
    .split(/^## /m)
    .find((part) => part.startsWith("Mapa de horários"));
  const lines = (section ?? "")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2);

  return lines.map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));

    return {
      entry: cells[0],
      where: cells[1],
      schedule: cells[2] === "—" ? null : cells[2],
      days: cells[3],
      window: parseWindow(cells[4]),
      heavy: cells[5] === "sim",
    };
  });
}

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "todo dia", "seg–sáb, exceto dia 1", "dia 1", "dom": does it run on `day`? */
function runsOn(days: string, day: Date): boolean {
  let included = false;
  let excluded = false;

  for (const token of days.split(",").map((part) => part.trim())) {
    const except = token.match(/^exceto dia (\d+)$/);
    const dayOfMonth = token.match(/^dia (\d+)$/);
    const range = token.match(/^(\S+?)\s*–\s*(\S+)$/);

    if (token === "todo dia") {
      included = true;
    } else if (except) {
      excluded ||= day.getUTCDate() === Number(except[1]);
    } else if (dayOfMonth) {
      included ||= day.getUTCDate() === Number(dayOfMonth[1]);
    } else if (range) {
      const from = WEEKDAYS.indexOf(range[1]);
      const to = WEEKDAYS.indexOf(range[2]);

      if (from < 0 || to < 0) throw new Error(`dias ilegíveis: ${days}`);

      included ||= day.getUTCDay() >= from && day.getUTCDay() <= to;
    } else if (WEEKDAYS.includes(token)) {
      included ||= day.getUTCDay() === WEEKDAYS.indexOf(token);
    } else {
      throw new Error(`dias ilegíveis: ${days}`);
    }
  }

  return included && !excluded;
}

/** A cron field as the set of values it allows: *, lists, ranges, steps. */
function cronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [range, step] = part.split("/");
    const [from, to] =
      range === "*"
        ? [min, max]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), step ? max : Number(range)];

    for (let value = from; value <= to; value += Number(step ?? 1)) {
      values.add(value);
    }
  }

  return values;
}

/** The cron's own day fields, the standard way (both set: either one). */
function cronRunsOn(schedule: string, day: Date): boolean {
  const [, , dayOfMonth, , dayOfWeek] = schedule.split(/\s+/);
  const byDate = cronField(dayOfMonth, 1, 31).has(day.getUTCDate());
  const byWeekday = cronField(dayOfWeek, 0, 6).has(day.getUTCDay());

  if (dayOfMonth !== "*" && dayOfWeek !== "*") return byDate || byWeekday;

  return byDate && byWeekday;
}

/** Three years of days: every weekday falls on every day of the month. */
function everyDay(): Date[] {
  const days: Date[] = [];
  const first = Date.UTC(2026, 10, 1);

  for (let index = 0; index < 3 * 366; index += 1) {
    days.push(new Date(first + index * 24 * 60 * 60 * 1000));
  }

  return days;
}

/** Heavy entries that share a minute on some day, as readable pairs. */
function overlaps(rows: MapRow[]): string[] {
  const heavy = rows.filter((row) => row.heavy && row.window);
  const found = new Set<string>();

  for (const day of everyDay()) {
    const today = heavy.filter((row) => runsOn(row.days, day));

    for (let i = 0; i < today.length; i += 1) {
      for (let j = i + 1; j < today.length; j += 1) {
        const a = today[i].window!;
        const b = today[j].window!;

        if (a.start < b.end && b.start < a.end) {
          found.add(`${today[i].entry} × ${today[j].entry}`);
        }
      }
    }
  }

  return [...found];
}

describe("the schedule map (docs/operacao/jobs.md)", () => {
  const rows = mapRows(readFileSync(JOBS_MAP, "utf8").replace(/\r\n/g, "\n"));
  const byEntry = new Map(rows.map((row) => [row.entry, row]));

  it("reads the table it is meant to check", () => {
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map((row) => row.entry)).size).toBe(rows.length);
  });

  it("lists every job the code registers, with the code's schedule", () => {
    const jobs = registered();
    const inCode = rows.filter((row) => row.where === "src/jobs/cron");

    for (const job of jobs) {
      const row = byEntry.get(job.name);

      expect(row, `${job.name} is missing from the map`).toBeDefined();
      expect(row!.where, job.name).toBe("src/jobs/cron");
      expect(row!.schedule, job.name).toBe(job.schedule);
    }

    // And nothing in the map claims a cron the code does not register.
    expect(inCode.map((row) => row.entry).sort()).toEqual(
      jobs.map((job) => job.name).sort(),
    );
  });

  it("has the scheduler's sweep, the partials' window and the weekly workflow", () => {
    expect(byEntry.get("catch-up")?.schedule).toBe(CATCH_UP_SCHEDULE);

    const [start, end] = DEFAULT_PARTIAL_RETRY_WINDOW_UTC.split("-");

    expect(byEntry.get("partial-retry")?.window).toEqual({
      start: minutesOf(start),
      end: minutesOf(end),
    });

    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/cloudflare-ranges.yml"),
      "utf8",
    );
    const weekly = byEntry.get("cloudflare-ranges")?.schedule;

    expect(weekly).toBeTruthy();
    expect(workflow).toContain(`cron: "${weekly}"`);
  });

  it("gives every heavy entry a window, starting where its schedule fires", () => {
    const budgetMinutes = DEFAULT_PURGE_RUN_BUDGET_MS / 60_000;

    for (const row of rows.filter((entry) => entry.heavy)) {
      expect(row.window, `${row.entry}: no window`).not.toBeNull();
      expect(row.window!.end, row.entry).toBeGreaterThan(row.window!.start);

      if (!row.schedule) continue;

      const [minute, hour] = row.schedule.split(/\s+/).map(Number);

      expect(row.window!.start, row.entry).toBe(hour * 60 + minute);

      // A purge stops at its budget: the window holds a whole run.
      if (row.where === "src/jobs/cron") {
        const length = row.window!.end - row.window!.start;

        expect(length, row.entry).toBeGreaterThanOrEqual(budgetMinutes);
      }

      // The "Dias" column says what the cron's own day fields say.
      const disagree = everyDay().filter(
        (day) => runsOn(row.days, day) !== cronRunsOn(row.schedule!, day),
      );

      expect(disagree, row.entry).toEqual([]);
    }
  });

  it("never has two heavy entries at the same minute, on any day", () => {
    expect(overlaps(rows)).toEqual([]);
  });

  it("is not vacuous: an overlap planted in the table is caught", () => {
    const planted: MapRow = {
      entry: "planted",
      where: "test",
      schedule: null,
      days: "dom",
      window: { start: minutesOf("06:30"), end: minutesOf("07:00") },
      heavy: true,
    };

    // Every Sunday it meets the history window; a Sunday that is the 1st,
    // the restore drill too.
    expect(overlaps([...rows, planted]).sort()).toEqual([
      "history-window × planted",
      "restore-drill × planted",
    ]);
    expect(runsOn("seg–sáb, exceto dia 1", new Date("2026-12-01"))).toBe(
      false,
    );
  });
});
