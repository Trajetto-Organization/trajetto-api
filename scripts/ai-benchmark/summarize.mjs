/**
 * Aggregates one or more run directories into the tables the report uses.
 *
 *   npx tsx scripts/ai-benchmark/summarize.mjs --dataset <dir> \
 *     --runs <run dir> [<run dir> ...] [--json <file>] [--markdown <file>]
 *
 * Latency percentiles are nearest-rank over successful calls. Throughput is
 * sequential (one request at a time): 3600 / mean seconds per image.
 */
import fs from "node:fs";
import path from "node:path";

import { PROOF_CRITERIA, scoreItem } from "./evaluate.mjs";
import { VARIANT_TASKS } from "./prompts.mjs";

// Claude Haiku 4.5 list price, USD per million tokens
// (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-28).
const HAIKU_PRICE = { inputPerMTok: 1, outputPerMTok: 5 };

function parseArgs(argv) {
  const args = { dataset: null, runs: [], json: null, markdown: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dataset") args.dataset = path.resolve(argv[++i]);
    else if (flag === "--json") args.json = path.resolve(argv[++i]);
    else if (flag === "--markdown") args.markdown = path.resolve(argv[++i]);
    else if (flag === "--runs") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.runs.push(path.resolve(argv[++i]));
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.dataset || args.runs.length === 0) throw new Error("--dataset and --runs are required");
  return args;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const ratio = (hits, total) => ({ hits, total, rate: total ? hits / total : null });

/** Prompt tokens per second of prefill, or null when the provider does not say. */
function prefillRate(record) {
  const ms = record.metrics?.promptEvalMs;
  if (record.error || !record.inputTokens || !(ms > 0)) return null;

  return record.inputTokens / (ms / 1000);
}

// A prefill this many times faster than the run's lower quartile did not
// encode the image: it came from the KV cache of the previous request
// (measured: ~169 tok/s on a cache hit against 15-40 tok/s fresh on CPU).
const CACHE_HIT_PREFILL_FACTOR = 3;

/**
 * Calls whose latency is not what a fresh photo costs. Ollama still reports
 * the whole prompt in prompt_eval_count on a cache hit, so the only reliable
 * signal is the prefill rate against the run's own lower quartile.
 */
function cacheHitSuspects(records) {
  const rates = records.map(prefillRate).filter((rate) => rate !== null);
  const reference = percentile(rates, 25);
  if (reference === null) return new Set();

  return new Set(
    records.filter((record) => {
      const rate = prefillRate(record);
      return rate !== null && rate > CACHE_HIT_PREFILL_FACTOR * reference;
    }),
  );
}

function latencyStats(suspects, records) {
  const seconds = records.filter((r) => !r.error && r.wallMs != null).map((r) => r.wallMs / 1000);
  const avg = mean(seconds);
  return {
    n: seconds.length,
    p50: percentile(seconds, 50),
    p95: percentile(seconds, 95),
    mean: avg,
    max: seconds.length ? Math.max(...seconds) : null,
    perHour: avg ? 3600 / avg : null,
    inputTokens: mean(records.filter((r) => r.inputTokens != null).map((r) => r.inputTokens)),
    outputTokens: mean(records.filter((r) => r.outputTokens != null).map((r) => r.outputTokens)),
    promptEvalSeconds: mean(records.filter((r) => r.metrics?.promptEvalMs != null).map((r) => r.metrics.promptEvalMs / 1000)),
    evalSeconds: mean(records.filter((r) => r.metrics?.evalMs != null).map((r) => r.metrics.evalMs / 1000)),
    cacheHitSuspects: records.filter((r) => suspects.has(r)).length,
  };
}

function resourceStats(samples, container) {
  const ours = samples.flatMap((s) => (s.containers || []).filter((c) => c.name === container));
  const others = samples.map((s) =>
    (s.containers || []).filter((c) => c.name !== container).reduce((sum, c) => sum + (c.cpuPercent || 0), 0),
  );
  const loads = samples.filter((s) => s.vmLoadavg).map((s) => s.vmLoadavg[0]);
  const host = samples.filter((s) => s.hostCpuPercent != null).map((s) => s.hostCpuPercent);
  const memoryStats = samples.map((s) => s.memoryStat).filter(Boolean);
  const peakGiB = (values) => (values.length ? Math.max(...values) / 1024 ** 3 : null);

  // Which other containers were actually busy, and for how long: a name in
  // the list says nothing about how much it competed.
  const busy = new Map();
  for (const sample of samples) {
    for (const c of sample.containers || []) {
      if (c.name === container || !(c.cpuPercent > 5)) continue;
      const entry = busy.get(c.name) ?? { name: c.name, busySamples: 0, cpuPercentSum: 0 };
      entry.busySamples += 1;
      entry.cpuPercentSum += c.cpuPercent;
      busy.set(c.name, entry);
    }
  }

  return {
    samples: samples.length,
    // docker stats usage: anon plus active page cache (mmapped weights
    // included), under the container's cap. Not the minimum the model needs.
    peakMemGiB: ours.length ? Math.max(...ours.map((c) => c.memBytes || 0)) / 1024 ** 3 : null,
    peakAnonGiB: peakGiB(memoryStats.map((m) => m.anonBytes).filter((v) => v != null)),
    peakFileGiB: peakGiB(memoryStats.map((m) => m.fileBytes).filter((v) => v != null)),
    busyOtherContainers: [...busy.values()]
      .map(({ name, busySamples, cpuPercentSum }) => ({
        name,
        busySamples,
        cpuPercentMeanWhenBusy: cpuPercentSum / busySamples,
      }))
      .sort((a, b) => b.busySamples - a.busySamples),
    containerCpuPercentMean: mean(ours.map((c) => c.cpuPercent || 0)),
    containerCpuPercentMax: ours.length ? Math.max(...ours.map((c) => c.cpuPercent || 0)) : null,
    otherContainersCpuPercentMean: mean(others),
    vmLoad1Min: loads.length ? Math.min(...loads) : null,
    vmLoad1Max: loads.length ? Math.max(...loads) : null,
    hostCpuPercentMean: mean(host),
    hostCpuPercentMax: host.length ? Math.max(...host) : null,
    // Host CPU minus our own container (docker reports % of one core; the
    // host figure is % of all logical CPUs): what the rest of the machine used.
    hostCpuPercentOthersMean: mean(
      samples
        .map((s) => {
          const self = (s.containers || []).find((c) => c.name === container);
          if (s.hostCpuPercent == null || !self || !s.hostCpus) return null;
          return Math.max(0, s.hostCpuPercent - (self.cpuPercent || 0) / s.hostCpus);
        })
        .filter((value) => value !== null),
    ),
  };
}

function accuracy(scored, variant) {
  const pick = (task) => scored.filter((s) => s.item.task === task && s.variant === variant && s.score);
  const odometer = pick("odometer");
  const checklist = pick("checklist");
  const proof = pick("proof");

  const cells = proof.flatMap((s) => Object.values(s.score.criteria));
  const truthYes = cells.filter((c) => c.truth === "yes");
  const perCriterion = Object.fromEntries(
    PROOF_CRITERIA.map((criterion) => {
      const list = proof.map((s) => s.score.criteria[criterion]).filter(Boolean);
      return [criterion, ratio(list.filter((c) => c.correct).length, list.length)];
    }),
  );
  const correctReceipts = proof.filter((s) => s.item.truth.expected === "looks_good");
  const defective = proof.filter((s) => s.item.truth.expected !== "looks_good");

  const result = {
    odometer: {
      status: ratio(odometer.filter((s) => s.score.statusOk).length, odometer.length),
      readExact: ratio(odometer.filter((s) => s.score.readExact === true).length, odometer.filter((s) => s.score.readExact !== null).length),
      falseVerified: odometer.filter((s) => s.score.falseVerified).length,
      falseAlarm: odometer.filter((s) => s.score.falseAlarm).length,
    },
    checklist: {
      match: ratio(checklist.filter((s) => s.score.ok).length, checklist.length),
      mileageRead: ratio(checklist.filter((s) => s.score.readExact === true).length, checklist.filter((s) => s.score.readExact !== undefined).length),
      fuelLevel: ratio(checklist.filter((s) => s.score.levelExact === true).length, checklist.filter((s) => s.score.levelExact !== undefined).length),
      tireCondition: ratio(checklist.filter((s) => s.score.conditionExact === true).length, checklist.filter((s) => s.score.conditionExact !== undefined).length),
      defaultedToConfirmed: checklist.filter((s) => s.score.defaultedToConfirmed).length,
    },
    proof: {
      suggestion: ratio(proof.filter((s) => s.score.suggestionOk).length, proof.length),
      looksGoodOnCorrect: ratio(correctReceipts.filter((s) => s.score.suggestion === "looks_good").length, correctReceipts.length),
      flaggedOnDefective: ratio(defective.filter((s) => s.score.suggestion !== "looks_good").length, defective.length),
      criteria: ratio(cells.filter((c) => c.correct).length, cells.length),
      perCriterion,
      abstained: cells.filter((c) => c.abstained).length,
      falseNo: ratio(truthYes.filter((c) => c.falseNo).length, truthYes.length),
      falseYes: cells.filter((c) => c.falseYes).length,
    },
  };

  if (variant === "extract") {
    result.proof.isReceipt = ratio(proof.filter((s) => s.score.isReceiptOk === true).length, proof.filter((s) => s.score.isReceiptOk !== null).length);
    result.proof.numberExact = ratio(proof.filter((s) => s.score.numberExact === true).length, proof.filter((s) => s.score.numberExact !== null).length);
  }

  return result;
}

/**
 * The last record of each item and variant. A resumed run appends the retry
 * of a call that failed in transport after the failed record; the failure is
 * kept only as a count, so it neither doubles the call nor stays an error.
 */
function latestRecords(allRecords) {
  const latest = new Map();
  for (const record of allRecords) latest.set(`${record.id}:${record.variant}`, record);

  const records = [...latest.values()];
  const kept = new Set(records);

  return { records, retriedErrors: allRecords.filter((r) => !kept.has(r) && r.error).length };
}

function summarizeRun(runDir, labels) {
  const info = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
  const { records, retriedErrors } = latestRecords(readJsonl(path.join(runDir, "results.jsonl")));
  const samples = readJsonl(path.join(runDir, "samples.jsonl"));
  const byId = new Map(labels.map((item) => [item.id, item]));

  const scored = records.map((record) => {
    const item = byId.get(record.id);
    let score = null;
    if (item && record.parsed) {
      try {
        score = scoreItem(item, record.parsed, record.variant);
      } catch (error) {
        score = null;
        record.scoreError = error.message;
      }
    }
    return { item, variant: record.variant, record, score };
  });

  const ok = records.filter((r) => !r.error);
  const limits = info.describe?.limits;
  const container = limits ? info.container ?? "trajetto-ai-bench-ollama" : null;
  const suspects = cacheHitSuspects(records);
  const usageIn = ok.reduce((sum, r) => sum + (r.inputTokens || 0), 0);
  const usageOut = ok.reduce((sum, r) => sum + (r.outputTokens || 0), 0);

  return {
    run: path.basename(runDir),
    provider: info.provider,
    model: info.model,
    config: limits ? `${limits.cpus} vCPU / ${(limits.memoryBytes / 1024 ** 3).toFixed(0)} GB` : "API",
    ollamaVersion: info.describe?.ollamaVersion ?? null,
    quantization: info.describe?.details?.quantization_level ?? null,
    maxSide: info.maxSide,
    temperature: info.temperature,
    calls: records.length,
    // Transport failures (timeout, 429, 529) left after the last resume, and
    // the ones a resume already retried. Neither says anything about JSON.
    errors: records.filter((r) => r.error).length,
    retriedErrors,
    jsonValid: ratio(ok.filter((r) => r.jsonValid).length, ok.length),
    coldLoad: info.segments?.[0]?.coldLoad ?? null,
    commands: (info.segments ?? []).map((segment) => segment.argv ?? null),
    latency: {
      all: latencyStats(suspects, records),
      prod: latencyStats(suspects, records.filter((r) => r.variant === "prod")),
      odometer: latencyStats(suspects, records.filter((r) => r.task === "odometer" && r.variant === "prod")),
      odometerBlind: latencyStats(suspects, records.filter((r) => r.task === "odometer" && r.variant === "blind")),
      checklist: latencyStats(suspects, records.filter((r) => r.task === "checklist")),
      proof: latencyStats(suspects, records.filter((r) => r.task === "proof" && r.variant === "prod")),
      proofExtract: latencyStats(suspects, records.filter((r) => r.task === "proof" && r.variant === "extract")),
    },
    resources: container ? resourceStats(samples, container) : null,
    cost:
      info.provider === "anthropic"
        ? {
            usd: (usageIn * HAIKU_PRICE.inputPerMTok + usageOut * HAIKU_PRICE.outputPerMTok) / 1e6,
            perImageUsd: ok.length ? (usageIn * HAIKU_PRICE.inputPerMTok + usageOut * HAIKU_PRICE.outputPerMTok) / 1e6 / ok.length : null,
          }
        : null,
    accuracy: { prod: accuracy(scored, "prod"), extract: accuracy(scored, "extract"), blind: accuracy(scored, "blind") },
    items: scored.map(({ item, variant, record, score }) => ({
      id: record.id,
      variant,
      seconds: record.wallMs != null ? record.wallMs / 1000 : null,
      error: record.error ?? record.parseError ?? null,
      verdict: score ? score.status ?? score.suggestion : null,
      ok: score ? score.statusOk ?? score.ok ?? score.suggestionOk : false,
      read: score?.readValue ?? score?.readNumber ?? null,
      observation: record.parsed?.observacao ?? null,
      expected: item?.truth?.expected ?? (item?.truth?.expectedMatch === undefined ? null : item.truth.expectedMatch ? "confirmed" : "contradicts"),
    })),
  };
}

const pct = (r) => (r && r.total ? `${(100 * r.rate).toFixed(0)}% (${r.hits}/${r.total})` : "—");
const num = (value, digits = 1) => (value == null ? "—" : Number(value).toFixed(digits));

function markdown(summaries) {
  const lines = [];
  lines.push("| Execução | Config | Chamadas | Erros de transporte (retentados) | JSON válido | p50 (s) | p95 (s) | média (s) | máx (s) | vazão seq. (img/h) | tokens entrada | tokens saída | RAM pico, docker stats (GiB) | RAM anônima pico (GiB) | carga a frio (s) | suspeitas de cache (prefill > 3× p25) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    const l = s.latency.all;
    lines.push(`| ${s.run} | ${s.config}${s.maxSide && s.maxSide !== "as captured (<= 1600)" ? `, ${s.maxSide}px` : ""} | ${s.calls} | ${s.errors} (${s.retriedErrors}) | ${pct(s.jsonValid)} | ${num(l.p50)} | ${num(l.p95)} | ${num(l.mean)} | ${num(l.max)} | ${num(l.perHour, 0)} | ${num(l.inputTokens, 0)} | ${num(l.outputTokens, 0)} | ${num(s.resources?.peakMemGiB, 2)} | ${num(s.resources?.peakAnonGiB, 2)} | ${s.coldLoad ? num(s.coldLoad.wallMs / 1000) : "—"} | ${l.cacheHitSuspects} |`);
  }

  lines.push("");
  lines.push("| Execução | Tarefa | p50 (s) | p95 (s) | média (s) | prefill médio (s) | geração média (s) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    for (const [task, l] of Object.entries(s.latency)) {
      if (task === "all" || task === "prod" || !l.n) continue;
      lines.push(`| ${s.run} | ${task} | ${num(l.p50)} | ${num(l.p95)} | ${num(l.mean)} | ${num(l.promptEvalSeconds)} | ${num(l.evalSeconds)} |`);
    }
  }

  lines.push("");
  lines.push("| Execução | Prompt do odômetro | Odômetro: status certo | Odômetro: leitura exata | \"Verificado\" indevido | Falso alarme | Checklist: confere/contradiz certo | km do checklist exato | nível de combustível exato | condição do pneu exata |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) for (const variant of ["prod", "blind"]) {
    const a = s.accuracy[variant];
    if (!a.odometer.status.total) continue;
    lines.push(`| ${s.run} | ${variant === "prod" ? "produção" : "cego (sem km informado)"} | ${pct(a.odometer.status)} | ${pct(a.odometer.readExact)} | ${a.odometer.falseVerified} | ${a.odometer.falseAlarm} | ${pct(a.checklist.match)} | ${pct(a.checklist.mileageRead)} | ${pct(a.checklist.fuelLevel)} | ${pct(a.checklist.tireCondition)} |`);
  }

  lines.push("");
  lines.push("| Execução | Prompt | Sugestão certa | looks_good nos corretos | sinalizou os defeituosos | critérios certos | \"não\" falso | \"sim\" falso | abstenções | é canhoto certo | número lido exato |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    for (const variant of ["prod", "extract"]) {
      const p = s.accuracy[variant].proof;
      if (!p.suggestion.total) continue;
      lines.push(`| ${s.run} | ${variant === "prod" ? "produção" : "extração (6.9)"} | ${pct(p.suggestion)} | ${pct(p.looksGoodOnCorrect)} | ${pct(p.flaggedOnDefective)} | ${pct(p.criteria)} | ${pct(p.falseNo)} | ${p.falseYes} | ${p.abstained} | ${pct(p.isReceipt)} | ${pct(p.numberExact)} |`);
    }
  }

  lines.push("");
  lines.push("| Execução | CPU do container média/máx (%) | CPU do host média/máx (%) | CPU do host sem o container (média, %) | load 1 min da VM Docker (mín–máx) | CPU de outros containers (média, %) | outros containers ocupados (> 5% CPU; amostras) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    const r = s.resources;
    if (!r) continue;
    lines.push(`| ${s.run} | ${num(r.containerCpuPercentMean, 0)} / ${num(r.containerCpuPercentMax, 0)} | ${num(r.hostCpuPercentMean, 0)} / ${num(r.hostCpuPercentMax, 0)} | ${num(r.hostCpuPercentOthersMean, 0)} | ${num(r.vmLoad1Min, 2)}–${num(r.vmLoad1Max, 2)} | ${num(r.otherContainersCpuPercentMean, 1)} | ${r.busyOtherContainers.map((c) => `${c.name} (${c.busySamples}/${r.samples})`).join(", ") || "—"} |`);
  }

  return `${lines.join("\n")}\n`;
}

function itemsMarkdown(summaries, labels) {
  const header = ["Item", "Descrição", "Esperado", ...summaries.map((s) => s.run)];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const item of labels) {
    for (const variant of Object.keys(VARIANT_TASKS).filter((v) => VARIANT_TASKS[v].includes(item.task))) {
      const expected = item.truth.expected ?? (item.truth.expectedMatch ? "confirmed" : "contradicts");
      const cells = summaries.map((s) => {
        const hit = s.items.find((entry) => entry.id === item.id && entry.variant === variant);
        if (!hit) return "—";
        if (hit.error && !hit.verdict) return `erro`;
        const read = hit.read != null ? ` (${hit.read})` : "";
        return `${hit.ok ? "✓" : "✗"} ${hit.verdict}${read} ${num(hit.seconds, 0)}s`;
      });
      lines.push(`| ${item.id}${variant === "prod" ? "" : ` (${variant === "extract" ? "extração" : "cego"})`} | ${item.description} | ${Array.isArray(expected) ? expected.join("/") : expected} | ${cells.join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const labels = JSON.parse(fs.readFileSync(path.join(args.dataset, "labels.json"), "utf8"));
  const summaries = args.runs.map((runDir) => summarizeRun(runDir, labels));

  const text = `${markdown(summaries)}\n${itemsMarkdown(summaries, labels)}`;
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(summaries, null, 2)}\n`);
  if (args.markdown) fs.writeFileSync(args.markdown, text);
  process.stdout.write(text);
}

main();
