/**
 * The per-task tables of the 10/2026 benchmark (results-2026-10.md): for each
 * run, latency, memory, cold load, contention and the accuracy of each
 * question the product asks, scored by evaluate.mjs (the product's rules).
 *
 *   npx tsx scripts/ai-benchmark/report.mjs --dataset <dir> --runs <dir...> \
 *     [--subset all|base|variations] [--json <file>]
 *
 * "base" is the 44 original items, "variations" the --variations captures.
 */
import fs from "node:fs";
import path from "node:path";

import { scoreItem } from "./evaluate.mjs";

function parseArgs(argv) {
  const args = { dataset: null, runs: [], subset: "all", json: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dataset") args.dataset = path.resolve(argv[++i]);
    else if (flag === "--subset") args.subset = argv[++i];
    else if (flag === "--json") args.json = path.resolve(argv[++i]);
    else if (flag === "--runs") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--"))
        args.runs.push(path.resolve(argv[++i]));
    } else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const frac = (hits, total) => (total ? `${hits}/${total}` : "—");

function resources(samples, container) {
  const ours = samples.flatMap((s) =>
    (s.containers || []).filter((c) => c.name === container),
  );
  const anon = samples
    .map((s) => s.memoryStat?.anonBytes)
    .filter((v) => v != null);
  const host = samples
    .map((s) => {
      const self = (s.containers || []).find((c) => c.name === container);
      if (s.hostCpuPercent == null || !self || !s.hostCpus) return null;
      return Math.max(
        0,
        s.hostCpuPercent - (self.cpuPercent || 0) / s.hostCpus,
      );
    })
    .filter((v) => v !== null);
  const busy = new Set();
  for (const s of samples)
    for (const c of s.containers || [])
      if (c.name !== container && c.cpuPercent > 5) busy.add(c.name);

  return {
    peakMemGiB: ours.length
      ? Math.max(...ours.map((c) => c.memBytes || 0)) / 1024 ** 3
      : null,
    peakAnonGiB: anon.length ? Math.max(...anon) / 1024 ** 3 : null,
    cpuMean: mean(ours.map((c) => c.cpuPercent || 0)),
    hostOthersMean: mean(host),
    hostOthersMax: host.length ? Math.max(...host) : null,
    busyOthers: [...busy],
  };
}

function summarize(runDir, labels, subset) {
  const info = JSON.parse(
    fs.readFileSync(path.join(runDir, "run.json"), "utf8"),
  );
  const latest = new Map();
  for (const record of readJsonl(path.join(runDir, "results.jsonl"))) {
    if (record.variant === "prod") latest.set(record.id, record);
  }
  const byId = new Map(labels.map((item) => [item.id, item]));
  const inSubset = (item) =>
    subset === "all" ||
    (subset === "base" ? !item.variation : Boolean(item.variation));

  const scored = [];
  for (const record of latest.values()) {
    const item = byId.get(record.id);
    if (!item || !inSubset(item)) continue;
    const score = record.parsed ? scoreItem(item, record.parsed) : null;
    scored.push({ item, record, score });
  }

  const ok = scored.filter((s) => !s.record.error);
  const secs = ok.map((s) => s.record.wallMs / 1000);
  const proof = scored.filter((s) => s.item.task === "proof");
  const odo = scored.filter(
    (s) =>
      s.item.task === "odometer" ||
      (s.item.task === "checklist" &&
        s.item.input.fieldName === "current_mileage"),
  );
  const visual = scored.filter(
    (s) =>
      s.item.task === "checklist" &&
      s.item.input.fieldName !== "current_mileage",
  );

  const criterion = (name) => {
    const cells = proof
      .map((s) => s.score?.criteria?.[name] ?? null)
      .filter(Boolean);
    const truthNo = cells.filter((c) => c.truth === "no");
    const truthYes = cells.filter((c) => c.truth === "yes");
    return {
      correct: frac(cells.filter((c) => c.correct).length, cells.length),
      falseYes: frac(
        truthNo.filter((c) => c.answer === "yes").length,
        truthNo.length,
      ),
      falseNo: frac(
        truthYes.filter((c) => c.answer === "no").length,
        truthYes.length,
      ),
      abstained: cells.filter((c) => c.abstained).length,
    };
  };

  const withNumber = proof.filter((s) => s.item.truth.printedNumber);
  const withReceipt = proof.filter(
    (s) => s.score && s.score.isReceiptOk !== null,
  );
  const odoReadable = odo.filter((s) => s.item.truth.reading != null);
  const exactRead = (s) =>
    Number(s.record.parsed?.valor_lido) === s.item.truth.reading;

  const segments = info.segments ?? [];
  const container = info.container ?? null;

  return {
    run: path.basename(runDir),
    model: info.model,
    provider: info.provider,
    maxSide: info.maxSide,
    calls: scored.length,
    errors: scored.filter((s) => s.record.error).length,
    jsonValid: frac(
      ok.filter(
        (s) =>
          s.score &&
          s.score.status !== "invalid" &&
          s.score.suggestion !== "invalid",
      ).length,
      ok.length,
    ),
    p50: percentile(secs, 50),
    p95: percentile(secs, 95),
    meanSecs: mean(secs),
    perHour: secs.length ? 3600 / mean(secs) : null,
    coldLoad: segments[0]?.coldLoad ?? null,
    resources: container
      ? resources(readJsonl(path.join(runDir, "samples.jsonl")), container)
      : null,
    proof: {
      suggestion: frac(
        proof.filter((s) => s.score?.suggestionOk).length,
        proof.length,
      ),
      numberExact: frac(
        withNumber.filter((s) => s.score?.numberExact).length,
        withNumber.length,
      ),
      isReceipt: frac(
        withReceipt.filter((s) => s.score.isReceiptOk).length,
        withReceipt.length,
      ),
      date: criterion("dateVisible"),
      signature: criterion("hasSignature"),
      legible: criterion("legible"),
      document: criterion("documentMatches"),
      falseLooksGood: proof.filter(
        (s) =>
          s.item.truth.expected !== "looks_good" &&
          s.score?.suggestion === "looks_good",
      ).length,
    },
    odometer: {
      readExact: frac(odoReadable.filter(exactRead).length, odoReadable.length),
      status: frac(
        odo.filter((s) =>
          s.item.task === "odometer" ? s.score?.statusOk : s.score?.ok,
        ).length,
        odo.length,
      ),
      falseVerified: odo.filter((s) =>
        s.item.task === "odometer"
          ? s.score?.falseVerified
          : s.score?.status === "confirmed" && !s.item.truth.expectedMatch,
      ).length,
      misses: odoReadable
        .filter((s) => !exactRead(s))
        .map((s) => `${s.item.id}:${s.record.parsed?.valor_lido ?? "null"}`),
    },
    checklist: {
      match: frac(visual.filter((s) => s.score?.ok).length, visual.length),
      fuel: frac(
        visual.filter((s) => s.score?.levelExact).length,
        visual.filter((s) => s.score?.levelExact !== undefined).length,
      ),
      tyre: frac(
        visual.filter((s) => s.score?.conditionExact).length,
        visual.filter((s) => s.score?.conditionExact !== undefined).length,
      ),
      inconclusive: visual.filter((s) => s.score?.status === "inconclusive")
        .length,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const labels = JSON.parse(
    fs.readFileSync(path.join(args.dataset, "labels.json"), "utf8"),
  );
  const out = args.runs.map((run) => summarize(run, labels, args.subset));
  if (args.json)
    fs.writeFileSync(args.json, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

main();
