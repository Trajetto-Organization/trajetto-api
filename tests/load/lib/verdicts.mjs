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

/**
 * The ABBA of the GPS write path at the 5M gate's rate (plano-escala
 * LOAD-11): positions-abba.sh ran positions-5m.js with the group commit
 * and the session cache off (A) and on (B), and left the session: per run,
 * the arm, k6's summary, the points it counted in the database over the
 * run's window, the database's commits and the window's ops_sample.
 *
 * Passes when every run lost nothing (each point the API answered 200 for
 * is in the database, and no product failure), B never opened the group
 * commit's breaker and actually batched (A never did), and B's p95 is at
 * most `p95TolerancePct` (5) worse than A's; with `p95Ms` (the gate's 150),
 * B's p95 must also be under it. What B gained (commits per POST, the
 * p95, the cache's hits) is said either way: the owner reads it before
 * turning either on in production.
 */
function positionsAbbaVerdict(session, options = {}) {
  const tolerance = options.p95TolerancePct ?? 5;
  const runs = Array.isArray(session?.runs) ? session.runs : [];
  const reasons = [];

  const facts = runs.map((run) => {
    const summary = run.summary;
    const posts = countOf(summary, "http_reqs");
    const stored = countOf(summary, "positions_points_stored");
    const failures = rateOf(
      summary,
      "surface_failures{surface:route.positions}",
    );
    const p95 = statOf(
      summary,
      "surface_latency{surface:route.positions}",
      "p(95)",
    );
    const ops = run.ops ?? {};
    const label = `corrida ${run.n} (${run.arm})`;

    if (posts === 0) reasons.push(`${label}: nenhum envio`);
    if (stored === 0) {
      reasons.push(
        `${label}: nenhum ponto gravado (o fixture tem rotas em andamento?)`,
      );
    }
    if (failures === null || failures > 0) {
      reasons.push(
        `${label}: falhas de produto nas posições (${failures ?? "?"})`,
      );
    }
    if (run.dbPoints !== stored) {
      reasons.push(
        `${label}: ${stored} pontos respondidos com 200 e ${run.dbPoints} no banco`,
      );
    }
    if (run.arm === "B" && Number(ops.breakerOpens ?? 0) > 0) {
      reasons.push(
        `${label}: o disjuntor do group commit abriu ${ops.breakerOpens} vez(es)`,
      );
    }
    if (run.arm === "B" && Number(ops.batches ?? 0) === 0) {
      reasons.push(
        `${label}: nenhum lote do group commit (o POSITION_GROUP_COMMIT=on chegou às réplicas?)`,
      );
    }
    if (run.arm === "A" && Number(ops.batches ?? 0) > 0) {
      reasons.push(`${label}: lotes do group commit com o braço desligado`);
    }

    return {
      n: run.n,
      arm: run.arm,
      posts,
      stored,
      dbPoints: run.dbPoints,
      failures,
      p95,
      commits: Number(run.commits ?? 0),
      ops,
    };
  });

  const armOf = (arm) => {
    const of = facts.filter((fact) => fact.arm === arm);
    const posts = of.reduce((sum, fact) => sum + fact.posts, 0);
    const commits = of.reduce((sum, fact) => sum + fact.commits, 0);
    const p95s = of.map((fact) => fact.p95).filter((value) => value !== null);
    const hits = of.reduce(
      (sum, fact) => sum + Number(fact.ops.cacheHits ?? 0),
      0,
    );
    const misses = of.reduce(
      (sum, fact) => sum + Number(fact.ops.cacheMisses ?? 0),
      0,
    );

    return {
      runs: of.length,
      p95: p95s.length ? p95s.reduce((x, y) => x + y, 0) / p95s.length : null,
      commitsPerPost: posts > 0 ? commits / posts : null,
      cacheHitRate: hits + misses > 0 ? hits / (hits + misses) : null,
    };
  };

  const a = armOf("A");
  const b = armOf("B");

  if (a.runs < 2 || b.runs < 2 || a.runs !== b.runs) {
    reasons.push(
      `a sessão precisa de A e B na mesma conta, dois de cada (A ${a.runs}, B ${b.runs})`,
    );
  }

  const p95DeltaPct =
    a.p95 && b.p95 !== null ? ((b.p95 - a.p95) / a.p95) * 100 : null;

  if (p95DeltaPct === null) {
    reasons.push("sem p95 das posições para comparar os braços");
  } else if (p95DeltaPct > tolerance) {
    reasons.push(
      `o p95 do braço B ficou ${p95DeltaPct.toFixed(1)}% pior que o do A (tolerância ${tolerance}%)`,
    );
  }

  if (
    options.p95Ms !== undefined &&
    (b.p95 === null || b.p95 >= options.p95Ms)
  ) {
    reasons.push(
      `o p95 do braço B foi ${b.p95 ?? "?"} ms (limite ${options.p95Ms} ms)`,
    );
  }

  return {
    pass: reasons.length === 0,
    arms: { A: a, B: b },
    gain: {
      p95DeltaPct,
      commitsPerPost: { A: a.commitsPerPost, B: b.commitsPerPost },
      fewerCommits:
        a.commitsPerPost !== null && b.commitsPerPost !== null
          ? b.commitsPerPost < a.commitsPerPost
          : null,
    },
    runs: facts,
    reasons,
  };
}

/**
 * A day of the queues dropped under load (plano-escala LOAD-11):
 * queue-drop-under-load.mjs wrote its summary (`options.drop`: the day
 * drained, its three partitions gone, the failures in the dead letters,
 * the DROP in under a minute), and load.js or positions-5m.js ran beside
 * it. Passes when both hold and the load had no product failures past
 * `maxFailureRate` (1%) and a p95 under `p95Ms` (300). Without the
 * scene's summary, it fails.
 */
function queueDropVerdict(summary, options = {}) {
  const p95Ms = options.p95Ms ?? 300;
  const maxFailureRate = options.maxFailureRate ?? 0.01;
  const drop = options.drop ?? null;
  const p95 = statOf(summary, "surface_latency", "p(95)");
  const failures = rateOf(summary, "surface_failures");
  const reasons = [];

  if (!drop) reasons.push("sem o resumo do queue-drop-under-load.mjs");
  else if (!drop.pass) reasons.push(...(drop.reasons ?? ["o DROP falhou"]));

  if (p95 === null || p95 >= p95Ms) {
    reasons.push(
      `carga com p95 de ${p95 ?? "?"} ms durante o DROP (limite ${p95Ms} ms)`,
    );
  }
  if (failures === null || failures > maxFailureRate) {
    reasons.push("falhas de produto na carga durante o DROP");
  }

  return {
    pass: reasons.length === 0,
    day: drop?.day ?? null,
    dropSeconds: drop?.dropSeconds ?? null,
    drainSeconds: drop?.drainSeconds ?? null,
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
  "positions-abba": positionsAbbaVerdict,
  "queue-drop": queueDropVerdict,
};

export {
  OUTAGE_DEFAULTS,
  VERDICTS,
  countOf,
  drainVerdict,
  metricOf,
  noisyTenantVerdict,
  outageVerdict,
  positionsAbbaVerdict,
  queueDropVerdict,
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

  // The drain's and the DROP's verdicts read the scripts' own summaries
  // by their paths.
  if (typeof options.drainFile === "string") {
    options.drain = JSON.parse(readFileSync(options.drainFile, "utf8"));
  }
  if (typeof options.dropFile === "string") {
    options.drop = JSON.parse(readFileSync(options.dropFile, "utf8"));
  }

  const verdict = judge(summary, options);

  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.pass ? 0 : 1);
}
