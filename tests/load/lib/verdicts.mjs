import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The acceptances of the load scenes, judged from k6's summary-export
 * (plano-escala LOAD-03; read by the gate's report, LOAD-08).
 *
 * k6 thresholds compare a metric with a number, never two windows of a run
 * with each other, and those comparisons are what the plan's acceptances
 * are: the normal tenants' p95 with the noisy one against without it, the
 * phones' POST/s during and after an outage against before it. So each
 * scene tags its samples (class, stage, window), names the tagged
 * submetrics in always-holding thresholds so the export carries them
 * (`breakdownOf` in lib/api.js), and this file does the arithmetic.
 *
 * Plain Node, no k6 import: `node tests/load/lib/verdicts.mjs <scene>
 * <summary.json>` prints the verdict as JSON and exits 1 when it fails.
 */

/** One metric of the export; null when the run produced none. */
function metricOf(summary, name) {
  return summary?.metrics?.[name] ?? null;
}

/** A trend's statistic (`p(95)`, `max`); null without samples. */
function statOf(summary, name, stat) {
  const value = metricOf(summary, name)?.[stat];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A rate's value (0..1); null without samples. */
function rateOf(summary, name) {
  const metric = metricOf(summary, name);

  if (!metric) return null;

  if (typeof metric.value === "number") return metric.value;
  if (typeof metric.rate === "number") return metric.rate;

  const passes = Number(metric.passes ?? 0);
  const fails = Number(metric.fails ?? 0);

  return passes + fails > 0 ? passes / (passes + fails) : null;
}

/** A counter's count; 0 without samples. */
function countOf(summary, name) {
  const count = metricOf(summary, name)?.count;

  return typeof count === "number" ? count : 0;
}

/**
 * noisy-tenant.js: one company at ten times the rate, beside twenty normal
 * ones. Passes when the normals' p95 with the noisy one stays within
 * `tolerance` (10%) of their p95 without it and no normal read failed; with
 * `expectThrottle` (the panel budget in enforce), the noisy company must
 * also have been refused.
 */
function noisyTenantVerdict(
  summary,
  { tolerance = 0.1, expectThrottle = false } = {},
) {
  const baselineP95 = statOf(
    summary,
    "surface_latency{class:normal,stage:baseline}",
    "p(95)",
  );
  const noisyP95 = statOf(
    summary,
    "surface_latency{class:normal,stage:noisy}",
    "p(95)",
  );
  const normalFailures = rateOf(summary, "surface_failures{class:normal}");
  const noisyThrottled = rateOf(summary, "surface_throttled{class:noisy}");

  const reasons = [];

  if (baselineP95 === null || noisyP95 === null) {
    reasons.push("faltam amostras dos normais antes ou durante o barulho");
  }

  const ratio =
    baselineP95 && noisyP95 !== null ? noisyP95 / baselineP95 : null;

  if (ratio !== null && ratio > 1 + tolerance) {
    reasons.push(
      `o p95 dos normais subiu ${Math.round((ratio - 1) * 100)}% com o barulhento (limite ${Math.round(tolerance * 100)}%)`,
    );
  }

  if ((normalFailures ?? 0) > 0) {
    reasons.push("houve leitura dos normais que falhou");
  }

  if (expectThrottle && !((noisyThrottled ?? 0) > 0)) {
    reasons.push("o barulhento não recebeu 429");
  }

  return {
    pass: reasons.length === 0,
    baselineP95,
    noisyP95,
    ratio,
    normalFailures,
    noisyThrottled,
    reasons,
  };
}

/** The stages outage.js tags its attempts with, and their default lengths. */
const OUTAGE_DEFAULTS = {
  baseSeconds: 120,
  downSeconds: 120,
  firstAfterSeconds: 60,
};

/**
 * outage.js: N phones, 2 minutes without the API. The plan's acceptance
 * (portão do 100k, com ≥ 90% de contrato 8): the POST/s that reach the API
 * stay at most 1.2× the base while it is down and 1.5× in the 60 s after.
 */
function outageVerdict(
  summary,
  {
    baseSeconds = OUTAGE_DEFAULTS.baseSeconds,
    downSeconds = OUTAGE_DEFAULTS.downSeconds,
    firstAfterSeconds = OUTAGE_DEFAULTS.firstAfterSeconds,
    downFactor = 1.2,
    afterFactor = 1.5,
  } = {},
) {
  const base = countOf(summary, "outage_attempts{stage:base}") / baseSeconds;
  const down = countOf(summary, "outage_attempts{stage:down}") / downSeconds;
  const after =
    countOf(summary, "outage_attempts{stage:after60}") / firstAfterSeconds;

  const reasons = [];

  if (base <= 0) reasons.push("nenhum envio antes da queda");

  if (base > 0 && down > base * downFactor) {
    reasons.push(
      `durante a queda, ${down.toFixed(2)} envios/s contra ${base.toFixed(2)} da base (limite ${downFactor}×)`,
    );
  }

  if (base > 0 && after > base * afterFactor) {
    reasons.push(
      `nos ${firstAfterSeconds} s depois, ${after.toFixed(2)} envios/s contra ${base.toFixed(2)} da base (limite ${afterFactor}×)`,
    );
  }

  return {
    pass: reasons.length === 0,
    postsPerSecond: { base, down, after },
    reasons,
  };
}

/**
 * spike.js with SPIKE_ACCEPTANCE=true (load shedding in enforce): no
 * product failure, p95 under 1 s, no request past 10 s, and the quiet
 * windows after each wall back under 1 s.
 */
function spikeVerdict(summary) {
  const failures = rateOf(summary, "surface_failures");
  const p95 = statOf(summary, "surface_latency", "p(95)");
  const max = statOf(summary, "surface_latency", "max");
  const recoveryP95 = statOf(
    summary,
    "surface_latency{window:recovery}",
    "p(95)",
  );

  const reasons = [];

  if (failures === null || failures > 0) {
    reasons.push("falhas de produto no pico");
  }
  if (p95 === null || p95 >= 1_000) reasons.push("p95 de 1 s ou mais");
  if (max === null || max >= 10_000) reasons.push("requisição de 10 s ou mais");
  if (recoveryP95 === null || recoveryP95 >= 1_000) {
    reasons.push("as janelas depois das paredes não voltaram abaixo de 1 s");
  }

  return {
    pass: reasons.length === 0,
    failures,
    p95,
    max,
    recoveryP95,
    reasons,
  };
}

/**
 * The drain of a backlog (plano-escala LOAD-04): drain-backlog.mjs wrote
 * its summary (`options.drain`: drained in under 15 minutes, no row
 * FAILED), and load.js ran beside it. Passes when both hold and the HTTP
 * stayed in p95 under `p95Ms` (300) without product failures. Without the
 * drain's summary, it fails: a load run alone proves nothing of a drain.
 */
function drainVerdict(summary, options = {}) {
  const p95Ms = options.p95Ms ?? 300;
  const drain = options.drain ?? null;
  const p95 = statOf(summary, "surface_latency", "p(95)");
  const failures = rateOf(summary, "surface_failures");
  const reasons = [];

  if (!drain) reasons.push("sem o resumo do drain-backlog.mjs");
  else if (!drain.pass) reasons.push(...(drain.reasons ?? ["o dreno falhou"]));

  if (p95 === null || p95 >= p95Ms) {
    reasons.push(
      `HTTP com p95 de ${p95 ?? "?"} ms durante o dreno (limite ${p95Ms} ms)`,
    );
  }
  if (failures === null || failures > 0.01) {
    reasons.push("falhas de produto no HTTP durante o dreno");
  }

  return {
    pass: reasons.length === 0,
    drainSeconds: drain?.drainSeconds ?? null,
    p95,
    failures,
    reasons,
  };
}

const VERDICTS = {
  "noisy-tenant": noisyTenantVerdict,
  outage: outageVerdict,
  spike: spikeVerdict,
  drain: drainVerdict,
};

export {
  OUTAGE_DEFAULTS,
  VERDICTS,
  countOf,
  drainVerdict,
  metricOf,
  noisyTenantVerdict,
  outageVerdict,
  rateOf,
  spikeVerdict,
  statOf,
};

// `node tests/load/lib/verdicts.mjs <scene> <summary.json> [options as JSON]`
const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const [scene, file, optionsJson] = process.argv.slice(2);
  const judge = VERDICTS[scene];

  if (!judge || !file) {
    console.error(
      `uso: node tests/load/lib/verdicts.mjs <${Object.keys(VERDICTS).join("|")}> <summary.json> [opções em JSON]`,
    );
    process.exit(2);
  }

  const summary = JSON.parse(readFileSync(file, "utf8"));
  const options = optionsJson ? JSON.parse(optionsJson) : {};

  // The drain's verdict reads the script's own summary by its path.
  if (typeof options.drainFile === "string") {
    options.drain = JSON.parse(readFileSync(options.drainFile, "utf8"));
  }

  const verdict = judge(summary, options);

  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.pass ? 0 : 1);
}
