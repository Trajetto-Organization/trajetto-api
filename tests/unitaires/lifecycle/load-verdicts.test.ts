import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The acceptances of the load scenes (plano-escala LOAD-03), judged from
 * k6's summary-export by tests/load/lib/verdicts.mjs.
 *
 * k6 thresholds compare a metric with a number, never one window of a run
 * with another, and that comparison is what the plan's acceptances are:
 * the normal companies' p95 with the noisy one against without it (≤ 10%),
 * the phones' POST/s during and after an outage against before it (1.2× and
 * 1.5×), the spike's quiet after each wall. A verdict that read the wrong
 * key, or a rate as a count, would pass every gate it judged. The summaries
 * here have the shape k6 2.2 wrote for these scenes against a stand-in
 * server (trends with p(95), rates with passes/fails/value, counters with
 * count).
 */
const VERDICTS = resolve(process.cwd(), "tests", "load", "lib", "verdicts.mjs");

type Verdicts = {
  drainVerdict: (summary: unknown, options?: object) => any;
  noisyTenantVerdict: (summary: unknown, options?: object) => any;
  outageVerdict: (summary: unknown, options?: object) => any;
  spikeVerdict: (summary: unknown) => any;
};

const load = () => import(pathToFileURL(VERDICTS).href) as Promise<Verdicts>;

const trend = (p95: number, max = p95 * 2) => ({
  avg: p95 / 2,
  min: 1,
  med: p95 / 2,
  max,
  "p(90)": p95 * 0.9,
  "p(95)": p95,
  "p(99)": p95 * 1.2,
  count: 100,
});

const rate = (value: number) => ({
  passes: Math.round(value * 100),
  fails: 100 - Math.round(value * 100),
  value,
});

function noisySummary(baseline: number, noisy: number, failures = 0) {
  return {
    metrics: {
      "surface_latency{class:normal,stage:baseline}": trend(baseline),
      "surface_latency{class:normal,stage:noisy}": trend(noisy),
      "surface_failures{class:normal}": rate(failures),
      "surface_throttled{class:noisy}": rate(0.3),
    },
  };
}

describe("the noisy-tenant verdict", () => {
  it("passes while the normals' p95 moves at most 10%", async () => {
    const { noisyTenantVerdict } = await load();

    expect(noisyTenantVerdict(noisySummary(100, 109))).toMatchObject({
      pass: true,
      ratio: 1.09,
    });
  });

  it("fails past 10%, or with a normal read that failed", async () => {
    const { noisyTenantVerdict } = await load();

    expect(noisyTenantVerdict(noisySummary(100, 112)).pass).toBe(false);
    expect(noisyTenantVerdict(noisySummary(100, 100, 0.01)).pass).toBe(false);
  });

  it("asks for the noisy one's 429 only with the budget in enforce", async () => {
    const { noisyTenantVerdict } = await load();
    const quiet = noisySummary(100, 100);

    quiet.metrics["surface_throttled{class:noisy}"] = rate(0);

    expect(noisyTenantVerdict(quiet).pass).toBe(true);
    expect(noisyTenantVerdict(quiet, { expectThrottle: true }).pass).toBe(
      false,
    );
  });

  it("never passes a run with no samples to compare", async () => {
    const { noisyTenantVerdict } = await load();

    expect(noisyTenantVerdict({ metrics: {} }).pass).toBe(false);
  });
});

function outageSummary(base: number, down: number, after60: number) {
  return {
    metrics: {
      "outage_attempts{stage:base}": { count: base, rate: 0 },
      "outage_attempts{stage:down}": { count: down, rate: 0 },
      "outage_attempts{stage:after60}": { count: after60, rate: 0 },
    },
  };
}

describe("the outage verdict", () => {
  it("divides each stage's attempts by its length", async () => {
    const { outageVerdict } = await load();

    // 2 min of base and of outage, 1 min after: 1/s, 1.2/s, 1.5/s.
    expect(outageVerdict(outageSummary(120, 144, 90))).toMatchObject({
      pass: true,
      postsPerSecond: { base: 1, down: 1.2, after: 1.5 },
    });
  });

  it("fails a retry storm while down, and a burst on the way back", async () => {
    const { outageVerdict } = await load();

    // Contract 7: every phone again every 15 s, then the backlog at once.
    expect(outageVerdict(outageSummary(120, 480, 60)).pass).toBe(false);
    expect(outageVerdict(outageSummary(120, 100, 120)).pass).toBe(false);
  });

  it("takes the stages' lengths the run was given", async () => {
    const { outageVerdict } = await load();

    expect(
      outageVerdict(outageSummary(20, 24, 90), {
        baseSeconds: 20,
        downSeconds: 20,
      }).postsPerSecond,
    ).toEqual({ base: 1, down: 1.2, after: 1.5 });
  });

  it("never passes a run that sent nothing before the outage", async () => {
    const { outageVerdict } = await load();

    expect(outageVerdict(outageSummary(0, 0, 0)).pass).toBe(false);
  });
});

describe("the spike verdict", () => {
  const spike = (overrides: Record<string, unknown> = {}) => ({
    metrics: {
      surface_failures: rate(0),
      surface_latency: trend(600, 4_000),
      "surface_latency{window:recovery}": trend(500),
      ...overrides,
    },
  });

  it("passes with no failure, p95 under 1 s, nothing past 10 s and the quiet back", async () => {
    const { spikeVerdict } = await load();

    expect(spikeVerdict(spike()).pass).toBe(true);
  });

  it("fails on each of them", async () => {
    const { spikeVerdict } = await load();

    expect(spikeVerdict(spike({ surface_failures: rate(0.001) })).pass).toBe(
      false,
    );
    expect(spikeVerdict(spike({ surface_latency: trend(1_000) })).pass).toBe(
      false,
    );
    expect(
      spikeVerdict(spike({ surface_latency: trend(600, 10_500) })).pass,
    ).toBe(false);
    expect(
      spikeVerdict(spike({ "surface_latency{window:recovery}": trend(1_200) }))
        .pass,
    ).toBe(false);
  });
});

describe("the command line", () => {
  it("prints the verdict and exits 1 when it fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-verdict-"));
    const file = join(dir, "noisy.json");

    writeFileSync(file, JSON.stringify(noisySummary(100, 150)));

    const result = spawnSync(
      process.execPath,
      [VERDICTS, "noisy-tenant", file],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ pass: false });
  });

  it("exits 0 when it passes, and 2 without a scene it knows", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-verdict-"));
    const file = join(dir, "noisy.json");

    writeFileSync(file, JSON.stringify(noisySummary(100, 100)));

    expect(
      spawnSync(process.execPath, [VERDICTS, "noisy-tenant", file]).status,
    ).toBe(0);
    expect(spawnSync(process.execPath, [VERDICTS, "nada", file]).status).toBe(
      2,
    );
  });
});

/**
 * The drain (plano-escala LOAD-04): drain-backlog.mjs judged the queues,
 * load.js measured the HTTP beside it. Both must hold, and a load run
 * without the drain's summary proves nothing of a drain.
 */
describe("the drain verdict", () => {
  const httpSummary = (p95: number, failures = 0) => ({
    metrics: {
      surface_latency: trend(p95),
      surface_failures: rate(failures),
    },
  });

  const drained = { pass: true, drainSeconds: 540, reasons: [] };

  it("passes with the drain in time and the HTTP in p95 under 300 ms", async () => {
    const { drainVerdict } = await load();

    expect(drainVerdict(httpSummary(240), { drain: drained })).toMatchObject({
      pass: true,
      drainSeconds: 540,
      p95: 240,
    });
  });

  it("fails on a slow HTTP, a failed drain, or no drain at all", async () => {
    const { drainVerdict } = await load();

    expect(drainVerdict(httpSummary(300), { drain: drained }).pass).toBe(false);
    expect(
      drainVerdict(httpSummary(200), {
        drain: { pass: false, reasons: ["drenou em 17 min (limite 15 min)"] },
      }),
    ).toMatchObject({
      pass: false,
      reasons: ["drenou em 17 min (limite 15 min)"],
    });
    expect(drainVerdict(httpSummary(200)).pass).toBe(false);
    expect(drainVerdict(httpSummary(200, 0.02), { drain: drained }).pass).toBe(
      false,
    );
  });

  it("reads the drain's summary by its path from the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-verdict-"));
    const http = join(dir, "drain-load.json");
    const drain = join(dir, "drain-backlog.json");

    writeFileSync(http, JSON.stringify(httpSummary(120)));
    writeFileSync(drain, JSON.stringify(drained));

    const result = spawnSync(
      process.execPath,
      [VERDICTS, "drain", http, JSON.stringify({ drainFile: drain })],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pass: true });
  });
});

/**
 * The replicas' own numbers over the import's window (plano-escala
 * LOAD-04, tests/load/lib/ops-window.mjs): the event-loop lag p99 of each
 * minute and the RSS against the container's ceiling.
 */
describe("the ops window verdict", () => {
  const OPS_WINDOW = resolve(
    process.cwd(),
    "tests",
    "load",
    "lib",
    "ops-window.mjs",
  );

  const loadWindow = () =>
    import(pathToFileURL(OPS_WINDOW).href) as Promise<{
      opsWindowVerdict: (rows: object[], options?: object) => any;
    }>;

  const minute = (
    replica: string,
    lag: number | null,
    rss: number | null,
    limit: number | null = 1_024,
  ) => ({
    replica,
    role: "api",
    lag_p99_ms: lag,
    rss_mb: rss,
    limit_mb: limit,
  });

  it("passes when every replica's worst minute stays under the lag and the ceiling", async () => {
    const { opsWindowVerdict } = await loadWindow();
    const verdict = opsWindowVerdict([
      minute("api-1", 20, 500),
      minute("api-1", 80, 700),
      minute("api-2", 30, 400),
    ]);

    expect(verdict.pass).toBe(true);
    expect(verdict.replicas).toEqual([
      expect.objectContaining({
        replica: "api-1",
        minutes: 2,
        maxLagP99Ms: 80,
        maxRssMb: 700,
        limitMb: 1_024,
      }),
      expect.objectContaining({ replica: "api-2", maxLagP99Ms: 30 }),
    ]);
  });

  it("fails on one minute past the lag, or an RSS at the ceiling", async () => {
    const { opsWindowVerdict } = await loadWindow();

    expect(
      opsWindowVerdict([minute("api-1", 20, 500), minute("api-1", 100, 500)])
        .pass,
    ).toBe(false);
    expect(opsWindowVerdict([minute("api-1", 20, 1_024)]).pass).toBe(false);
  });

  it("takes the ceiling from the command line when the rows carry none", async () => {
    const { opsWindowVerdict } = await loadWindow();
    const rows = [minute("api-1", 20, 600, null)];

    expect(opsWindowVerdict(rows).pass).toBe(false);
    expect(opsWindowVerdict(rows, { rssLimitMb: 1_024 }).pass).toBe(true);
  });

  it("never passes an empty window", async () => {
    const { opsWindowVerdict } = await loadWindow();

    expect(opsWindowVerdict([])).toMatchObject({
      pass: false,
      reasons: [expect.stringContaining("nenhuma linha de ops_sample")],
    });
  });
});
