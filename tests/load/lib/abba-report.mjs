import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { countOf, rateOf, statOf } from "./verdicts.mjs";

/**
 * The report of the ABBA bench (plano-escala LOAD-10): tests/load/cpu-abba.sh
 * leaves one folder of raw files per session, and this turns it into
 * docs/desempenho/bancada/<date>-<label>.md with a verdict.
 *
 * Each run is the api's CPU in the window (cgroup cpu.stat, every replica
 * summed), pg_stat_statements' calls in load_test and k6's summary of
 * load.js. Per request: the CPU over k6's requests, as the ADR 0011
 * measured it, and the statements over the same requests; both also net of
 * the idle background the script measured with no load.
 *
 * The verdict:
 *   - the control (A and B the same image): |Δ| < 5% in CPU and in
 *     statements. Above that the bench is noisier than the cuts it is
 *     meant to judge (F4-07 keeps a cut from 2%);
 *   - a cut (two images): B stays only with CPU down by 2% or more and the
 *     p95 at most 5% worse;
 *   - any run with 1% or more of failed requests, or none at all, makes the
 *     session invalid: a run that failed measures the failure.
 * The wave 15 target (≤ 6.0 ms and ≤ 7 statements per request) is said for
 * B, and only as indicative: the number that counts is the 1M gate's, on
 * the target hardware.
 *
 * `node tests/load/lib/abba-report.mjs <work> <report dir>` writes the
 * report, prints its path and exits 0 when the verdict passes, 1 otherwise.
 */

const CONTROL_MAX_DELTA = 5;
const CUT_MIN_GAIN = 2;
const P95_TOLERANCE = 5;
const MAX_FAILURE_RATE = 0.01;
const TARGET_CPU_MS = 6.0;
const TARGET_STATEMENTS = 7;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const perRequest = (value, requests) =>
  requests > 0 ? finite(value / requests) : null;

/** The numbers of one run, per request where it makes sense. */
function runFacts(run, summary) {
  const requests = countOf(summary, "http_reqs");
  const wall = Number(run.wallSeconds) || 0;
  const idleSeconds = Number(run.idle?.seconds) || 0;
  const apiUsec = Number(run.cpu?.apiUsec) || 0;
  const calls = Number(run.pgss?.calls) || 0;

  // The idle background scaled to the window, never below zero: what the
  // processes spend with no request at all.
  const idleUsec =
    idleSeconds > 0
      ? ((Number(run.idle?.apiUsec) || 0) / idleSeconds) * wall
      : 0;
  const idleCalls =
    idleSeconds > 0 ? ((Number(run.idle?.calls) || 0) / idleSeconds) * wall : 0;

  const failures =
    rateOf(summary, "surface_failures") ?? rateOf(summary, "http_req_failed");

  return {
    n: run.n,
    variant: run.variant,
    image: run.image,
    replicas: run.replicas,
    role: run.role,
    cpuset: run.cpuset,
    k6Exit: run.k6Exit,
    requests,
    rate: finite(metricRate(summary)),
    cpuMs: perRequest(apiUsec / 1000, requests),
    netCpuMs: perRequest(Math.max(0, apiUsec - idleUsec) / 1000, requests),
    statements: perRequest(calls, requests),
    netStatements: perRequest(Math.max(0, calls - idleCalls), requests),
    postgresCpuMs: perRequest(
      (Number(run.cpu?.postgresUsec) || 0) / 1000,
      requests,
    ),
    execMs: perRequest(Number(run.pgss?.execMs) || 0, requests),
    p50: statOf(summary, "http_req_duration", "med"),
    p95: statOf(summary, "http_req_duration", "p(95)"),
    p99: statOf(summary, "http_req_duration", "p(99)"),
    failures,
    memoryMb: (Number(run.apiMemoryBytes) || 0) / 1024 / 1024,
  };
}

function metricRate(summary) {
  return summary?.metrics?.http_reqs?.rate ?? null;
}

/** Mean and sample standard deviation; null without values. */
function stats(values) {
  const present = values.filter((value) => finite(value) !== null);

  if (present.length === 0) return null;

  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  const variance =
    present.length > 1
      ? present.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (present.length - 1)
      : 0;

  return { mean, stdev: Math.sqrt(variance), n: present.length };
}

/** B against A in percent; null when A is zero or missing. */
function delta(a, b) {
  if (!a || !b || a.mean === 0) return null;

  return ((b.mean - a.mean) / a.mean) * 100;
}

const MEASURES = [
  ["cpuMs", "CPU da api por requisição", "ms", 2],
  ["netCpuMs", "CPU da api por requisição, sem o repouso", "ms", 2],
  ["statements", "Statements por requisição", "", 2],
  ["netStatements", "Statements por requisição, sem o repouso", "", 2],
  ["postgresCpuMs", "CPU do Postgres por requisição", "ms", 2],
  ["execMs", "Execução no Postgres por requisição", "ms", 2],
  ["p50", "p50", "ms", 1],
  ["p95", "p95", "ms", 1],
  ["p99", "p99", "ms", 1],
  ["rate", "Vazão", "req/s", 1],
  ["memoryMb", "Memória da 1ª réplica no fim", "MB", 0],
];

/** The verdict of a session: the control, a cut, or invalid. */
function judge(meta, facts) {
  const control = Boolean(meta.aId) && meta.aId === meta.bId;
  const of = (variant, key) =>
    stats(facts.filter((f) => f.variant === variant).map((f) => f[key]));

  const cpu = { a: of("A", "cpuMs"), b: of("B", "cpuMs") };
  const statements = { a: of("A", "statements"), b: of("B", "statements") };
  const p95 = { a: of("A", "p95"), b: of("B", "p95") };
  const dCpu = delta(cpu.a, cpu.b);
  const dStatements = delta(statements.a, statements.b);
  const dP95 = delta(p95.a, p95.b);

  const problems = [];
  const expected = String(meta.order ?? "");
  const actual = facts.map((f) => f.variant).join("");

  if (actual !== expected)
    problems.push(
      `as corridas (${actual || "nenhuma"}) não seguem a ordem ${expected}`,
    );

  for (const f of facts) {
    if (!(f.requests > 0))
      problems.push(`a corrida ${f.n} não teve requisição`);
    else if (f.failures !== null && f.failures >= MAX_FAILURE_RATE)
      problems.push(
        `a corrida ${f.n} falhou ${pct(f.failures * 100)} das requisições (o limite é 1%)`,
      );
  }

  if (dCpu === null || dStatements === null)
    problems.push("faltam a CPU ou os statements de A ou de B");

  const lines = [];
  let passed;

  if (problems.length > 0) {
    passed = false;
    lines.push(`Inválido: ${problems.join("; ")}.`);
  } else if (control) {
    passed =
      Math.abs(dCpu) < CONTROL_MAX_DELTA &&
      Math.abs(dStatements) < CONTROL_MAX_DELTA;
    lines.push(
      passed
        ? `Controle A=B: Δ de ${signed(dCpu)} na CPU e de ${signed(dStatements)} nos statements, abaixo de ${CONTROL_MAX_DELTA}%. A bancada mede.`
        : `Controle A=B: Δ de ${signed(dCpu)} na CPU e de ${signed(dStatements)} nos statements; o limite é ${CONTROL_MAX_DELTA}%. A bancada está ruidosa demais para julgar um corte: feche o que disputa a CPU da máquina, use o vps-6vcpu.env e refaça.`,
    );
  } else {
    const gain = dCpu <= -CUT_MIN_GAIN;
    const p95Ok = dP95 === null || dP95 <= P95_TOLERANCE;

    passed = gain && p95Ok;
    lines.push(
      passed
        ? `O corte fica: a CPU por requisição caiu ${signed(dCpu)} (o mínimo é ${CUT_MIN_GAIN}%) e o p95 variou ${signed(dP95)} (até +${P95_TOLERANCE}%).`
        : `O corte sai: a CPU por requisição variou ${signed(dCpu)} (precisa cair ${CUT_MIN_GAIN}% ou mais) e o p95 ${signed(dP95)} (até +${P95_TOLERANCE}%).`,
    );
  }

  if (cpu.b && statements.b) {
    const reached =
      cpu.b.mean <= TARGET_CPU_MS && statements.b.mean <= TARGET_STATEMENTS;

    lines.push(
      `Meta da onda 15 para B (≤ ${num(TARGET_CPU_MS, 1)} ms e ≤ ${TARGET_STATEMENTS} statements por requisição): ${reached ? "sim" : "não"}, com ${num(cpu.b.mean, 2)} ms e ${num(statements.b.mean, 2)} statements. Indicativo na bancada; o número que vale é o do portão do 1M no hardware-alvo.`,
    );
  }

  return {
    kind: problems.length > 0 ? "inválido" : control ? "controle" : "corte",
    control,
    passed,
    delta: { cpu: dCpu, statements: dStatements, p95: dP95 },
    lines,
  };
}

function num(value, digits) {
  if (finite(value) === null) return "—";

  const [whole, fraction] = Math.abs(value).toFixed(digits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${value < 0 ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

function pct(value) {
  return `${num(value, 1)}%`;
}

function signed(value) {
  if (finite(value) === null) return "—";

  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${num(Math.abs(value), 1)}%`;
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

function meanCell(s, unit, digits) {
  if (!s) return "—";

  const suffix = unit ? ` ${unit}` : "";

  return s.n > 1
    ? `${num(s.mean, digits)} ± ${num(s.stdev, digits)}${suffix}`
    : `${num(s.mean, digits)}${suffix}`;
}

/** The markdown of a session read by `readWork`. */
function renderAbbaReport(work) {
  const { meta } = work;
  const facts = work.runs.map(({ run, summary }) => runFacts(run, summary));
  const verdict = judge(meta, facts);
  const first = facts[0] ?? {};
  const result = verdict.passed
    ? verdict.kind === "controle"
      ? "bancada confiável"
      : "o corte fica"
    : verdict.kind === "inválido"
      ? "inválido"
      : verdict.kind === "controle"
        ? "bancada ruidosa"
        : "o corte sai";

  const out = [];

  out.push(`# ABBA de CPU e statements: ${meta.label}`, "");
  out.push(
    "Gerado por `tests/load/cpu-abba.sh` (plano de escala LOAD-10), com o",
    "método do ADR 0011: as duas imagens se alternam no mesmo harness, cada",
    "corrida numa cópia nova do mesmo banco, com o `pg_stat_statements`",
    "zerado e a CPU lida do cgroup de cada contêiner.",
    "",
  );
  out.push("| Campo | Valor |", "| --- | --- |");
  out.push(`| Data | ${meta.date} |`);
  out.push(`| Resultado | ${result} |`);
  out.push(`| Commit do harness | ${cell(meta.commit)} |`);
  out.push(`| A | ${cell(meta.aImage)} (${short(meta.aId)}) |`);
  out.push(`| B | ${cell(meta.bImage)} (${short(meta.bId)}) |`);
  out.push(`| Controle (A=B) | ${verdict.control ? "sim" : "não"} |`);
  out.push(`| Ordem | ${meta.order} |`);
  out.push(
    `| Carga | load.js a ${meta.rate} operações/s por ${meta.durationSeconds} s, aquecimento de ${meta.warmupSeconds} s, repouso de ${meta.idleSeconds} s |`,
  );
  out.push(
    `| Réplicas da api | ${first.replicas ?? "?"} (PROCESS_ROLE=${cell(first.role ?? "?")}, cpuset ${cell(first.cpuset || "nenhum")}) |`,
  );
  out.push(
    `| Máquina | ${cell(meta.host)}, ${meta.nproc} núcleos, ${meta.dockerCpus} no docker |`,
  );
  out.push(`| Modelo do banco | ${cell(meta.template || "sem data")} |`, "");

  out.push("## Veredito", "");
  for (const line of verdict.lines) out.push(`- ${line}`);
  out.push("");

  out.push("## Média ± desvio", "");
  out.push("| Medida | A | B | Δ |", "| --- | --- | --- | --- |");
  for (const [key, label, unit, digits] of MEASURES) {
    const a = stats(facts.filter((f) => f.variant === "A").map((f) => f[key]));
    const b = stats(facts.filter((f) => f.variant === "B").map((f) => f[key]));

    out.push(
      `| ${label} | ${meanCell(a, unit, digits)} | ${meanCell(b, unit, digits)} | ${signed(delta(a, b))} |`,
    );
  }
  out.push("");

  out.push("## Por corrida", "");
  out.push(
    "| # | Variante | Requisições | CPU/req | Statements/req | Postgres/req | p95 | Falhas | k6 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const f of facts) {
    out.push(
      `| ${f.n} | ${f.variant} | ${num(f.requests, 0)} | ${num(f.cpuMs, 2)} ms | ${num(f.statements, 2)} | ${num(f.postgresCpuMs, 2)} ms | ${num(f.p95, 1)} ms | ${f.failures === null ? "—" : pct(f.failures * 100)} | ${f.k6Exit === 99 ? "limiar estourado" : f.k6Exit} |`,
    );
  }
  out.push("");

  const tops = ["A", "B"]
    .map((variant) =>
      [...work.runs].reverse().find(({ run }) => run.variant === variant),
    )
    .filter((entry) => entry && entry.top.length > 0);

  if (tops.length > 0) {
    out.push(
      "## Statements mais chamados (última corrida de cada variante)",
      "",
    );

    for (const { run, top } of tops) {
      out.push(`### ${run.variant} (corrida ${run.n})`, "");
      out.push(
        "| Chamadas | Execução (ms) | Statement |",
        "| --- | --- | --- |",
      );
      for (const [calls, execMs, query] of top) {
        out.push(
          `| ${calls} | ${execMs} | \`${cell(query).replace(/`/g, "'")}\` |`,
        );
      }
      out.push("");
    }
  }

  return {
    markdown: `${out.join("\n").trimEnd()}\n`,
    passed: verdict.passed,
    verdict,
  };
}

function short(id) {
  const value = String(id ?? "");

  return value.startsWith("sha256:") ? value.slice(7, 19) : value || "?";
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The raw files of one session, in the order of the runs. */
function readWork(dir) {
  const meta = readJson(join(dir, "meta.json"));
  const runs = readdirSync(dir)
    .map((name) => /^run-(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b)
    .map((n) => {
      const summaryPath = join(dir, `k6-${n}.json`);
      const topPath = join(dir, `pgss-top-${n}.tsv`);

      return {
        run: readJson(join(dir, `run-${n}.json`)),
        summary: existsSync(summaryPath) ? readJson(summaryPath) : null,
        top: existsSync(topPath)
          ? readFileSync(topPath, "utf8")
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => line.split("\t"))
          : [],
      };
    });

  return { meta, runs };
}

/** <date>-<label>.md, or -2, -3... when a session of the day exists. */
function reportName(dir, date, label) {
  let name = `${date}-${label}.md`;

  for (let k = 2; existsSync(join(dir, name)); k++) {
    name = `${date}-${label}-${k}.md`;
  }

  return name;
}

export {
  CONTROL_MAX_DELTA,
  CUT_MIN_GAIN,
  P95_TOLERANCE,
  TARGET_CPU_MS,
  TARGET_STATEMENTS,
  judge,
  readWork,
  renderAbbaReport,
  reportName,
  runFacts,
  stats,
};

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const [workDir, reportDir] = process.argv.slice(2);

  if (!workDir || !reportDir) {
    console.error(
      "uso: node abba-report.mjs <pasta da sessão> <pasta do relatório>",
    );
    process.exit(2);
  }

  const work = readWork(workDir);
  const { markdown, passed, verdict } = renderAbbaReport(work);
  const path = join(
    reportDir,
    reportName(reportDir, work.meta.date, work.meta.label),
  );

  writeFileSync(path, markdown);
  writeFileSync(join(workDir, "report.md"), markdown);

  console.log(`[abba] relatório: ${path}`);
  for (const line of verdict.lines) console.log(`[abba] ${line}`);

  process.exit(passed ? 0 : 1);
}
