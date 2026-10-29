/**
 * Runs the labeled set through one reader and records, per image, latency,
 * token counts, the raw answer and the parsed JSON.
 *
 *   npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
 *     --model gemma4:e2b-it-qat --dataset <dir> --out <run dir> \
 *     [--ollama-url http://127.0.0.1:11435] [--container trajetto-ai-bench-ollama] \
 *     [--variants prod] [--only P01,O03] [--max-side 1600] [--temperature 0] [--allow-drift]
 *
 *   npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider local \
 *     --dataset <dir> --out <run dir> [--url http://127.0.0.1:18080] [--token-env AI_LOCAL_TOKEN]
 *
 * `local` measures what the product runs (ADR 0010): the trajetto-ai service
 * built from infra/ai-ocr and the rules of src/shared/ai/local/ocr-readings.ts,
 * read from the source. The Anthropic path was removed with the provider
 * (decision 14.1); `ocr` stays for the experimental profiles of ocr-server/.
 *
 * One request at a time, like OLLAMA_NUM_PARALLEL=1 in production. Results
 * are appended to <out>/results.jsonl as they arrive, so an interrupted run
 * resumes where it stopped (calls that failed in transport are retried);
 * resource samples go to <out>/samples.jsonl, and <out>/run.json keeps the
 * exact arguments of every segment. The prompts are the product's own
 * (prompts.mjs); for Ollama the run refuses to start while a JSON schema no
 * longer matches its prompt, unless --allow-drift.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  VARIANT_TASKS,
  buildRequest,
  productClientSettings,
  schemaDrift,
} from "./prompts.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");

function parseArgs(argv) {
  const args = {
    provider: "ollama",
    model: null,
    dataset: path.join(apiRoot, "tmp/ai-benchmark/dataset"),
    out: null,
    ollamaUrl: "http://127.0.0.1:11435",
    ocrUrl: "http://127.0.0.1:18080",
    localUrl: "http://127.0.0.1:18080",
    tokenEnv: "AI_LOCAL_TOKEN",
    container: "trajetto-ai-bench-ollama",
    // The product's prompts are blind and extract since ADR 0010; the old
    // variant names only repeat them (prompts.mjs).
    variants: ["prod"],
    only: null,
    maxSide: null,
    temperature: 0,
    numCtx: 4096,
    timeoutMs: 600_000,
    allowDrift: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--provider") args.provider = next();
    else if (flag === "--model") args.model = next();
    else if (flag === "--dataset") args.dataset = path.resolve(next());
    else if (flag === "--out") args.out = path.resolve(next());
    else if (flag === "--ollama-url") args.ollamaUrl = next();
    else if (flag === "--ocr-url") args.ocrUrl = next();
    else if (flag === "--url") args.localUrl = next();
    else if (flag === "--token-env") args.tokenEnv = next();
    else if (flag === "--container") args.container = next();
    else if (flag === "--variants") args.variants = next().split(",");
    else if (flag === "--only") args.only = new Set(next().split(","));
    else if (flag === "--max-side") args.maxSide = Number(next());
    else if (flag === "--temperature") args.temperature = Number(next());
    else if (flag === "--num-ctx") args.numCtx = Number(next());
    else if (flag === "--timeout-ms") args.timeoutMs = Number(next());
    else if (flag === "--allow-drift") args.allowDrift = true;
    else throw new Error(`unknown flag ${flag}`);
  }

  if (args.provider === "anthropic") {
    throw new Error(
      "--provider anthropic was removed with the external provider (ADR 0010); use --provider local",
    );
  }
  if (args.provider === "local") args.model ??= "trajetto-ai";
  if (!args.model) throw new Error("--model is required for ollama");
  if (!args.out) throw new Error("--out is required");

  return args;
}

/** Reads one key from trajetto-api/.env without ever printing it. */
function readEnvKey(name) {
  if (process.env[name]) return process.env[name];

  const envFile = path.join(apiRoot, ".env");
  if (!fs.existsSync(envFile)) return null;

  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`));
    if (match) return match[1].replace(/^["']|["']$/g, "") || null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resource sampling: our container, every other container (contention from
// the rest of the machine), the Docker VM's load average and host CPU.
// ---------------------------------------------------------------------------

function parseBytes(text) {
  const match = String(text)
    .trim()
    .match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return null;
  const unit = match[2].toUpperCase();
  const factor =
    {
      B: 1,
      KIB: 1024,
      MIB: 1024 ** 2,
      GIB: 1024 ** 3,
      TIB: 1024 ** 4,
      KB: 1e3,
      MB: 1e6,
      GB: 1e9,
      TB: 1e12,
    }[unit] ?? 1;
  return Number(match[1]) * factor;
}

/**
 * Anonymous vs file-backed memory of the container's cgroup. docker stats
 * gives one number that mixes the model's own allocations with page cache
 * (mmapped weights included), and under a memory cap that number sits near
 * the cap whatever the model really needs; anon is what cannot be reclaimed.
 * Reads cgroup v2 (anon/file) and falls back to v1 (total_rss/total_cache).
 */
function parseMemoryStat(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && /^\d+$/.test(value ?? "")) values[key] = Number(value);
  }

  const anonBytes = values.anon ?? values.total_rss ?? values.rss ?? null;
  const fileBytes = values.file ?? values.total_cache ?? values.cache ?? null;
  if (anonBytes === null && fileBytes === null) return null;

  return { anonBytes, fileBytes };
}

function hostCpuTimes() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const total = Object.values(cpu.times).reduce(
        (sum, value) => sum + value,
        0,
      );
      return { idle: acc.idle + cpu.times.idle, total: acc.total + total };
    },
    { idle: 0, total: 0 },
  );
}

function startSampler({ container, samplesFile, enabled }) {
  if (!enabled) return { stop: async () => [] };

  const samples = [];
  let previousCpu = hostCpuTimes();
  let stopped = false;
  let loop;

  const sampleOnce = async () => {
    const at = new Date().toISOString();
    const sample = { at };

    try {
      const { stdout } = await run("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
      ]);
      sample.containers = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, cpu, mem] = line.split("|");
          return {
            name,
            cpuPercent: Number.parseFloat(cpu),
            memBytes: parseBytes(mem.split("/")[0]),
          };
        });
    } catch (error) {
      sample.dockerError = String(error.message).slice(0, 200);
    }

    try {
      const { stdout } = await run("docker", [
        "exec",
        container,
        "sh",
        "-c",
        "cat /proc/loadavg; cat /sys/fs/cgroup/memory.stat 2>/dev/null || cat /sys/fs/cgroup/memory/memory.stat",
      ]);
      const [loadLine, ...memoryLines] = stdout.trim().split(/\r?\n/);
      sample.vmLoadavg = loadLine.trim().split(/\s+/).slice(0, 3).map(Number);
      sample.memoryStat = parseMemoryStat(memoryLines.join("\n"));
    } catch {
      // container not running yet or already stopped
    }

    const cpu = hostCpuTimes();
    const idle = cpu.idle - previousCpu.idle;
    const total = cpu.total - previousCpu.total;
    previousCpu = cpu;
    sample.hostCpuPercent =
      total > 0 ? Number((100 * (1 - idle / total)).toFixed(1)) : null;
    sample.hostCpus = os.cpus().length;

    samples.push(sample);
    fs.appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
  };

  const tick = async () => {
    if (stopped) return;
    await sampleOnce();
    if (!stopped) loop = setTimeout(tick, 4000);
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(loop);
      return samples;
    },
  };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Same extraction the product does (ai-answers.ts): first {...} block. */
function parseLikeProduct(rawText) {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch)
    throw new Error(`no JSON in answer: ${rawText.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

function ollamaProvider(args) {
  const call = async (body) => {
    const response = await fetch(`${args.ollamaUrl}${body.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.payload),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    const json = await response.json();
    if (!response.ok || json.error)
      throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  };

  return {
    async describe() {
      const version = await (
        await fetch(`${args.ollamaUrl}/api/version`)
      ).json();
      const show = await call({
        path: "/api/show",
        payload: { model: args.model },
      });
      let limits = null;
      try {
        const { stdout } = await run("docker", [
          "inspect",
          "--format",
          "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.Config.Image}}",
          args.container,
        ]);
        const [nanoCpus, memory, image] = stdout.trim().split("|");
        limits = {
          cpus: Number(nanoCpus) / 1e9,
          memoryBytes: Number(memory),
          image,
        };
      } catch {
        // not a local container
      }
      return {
        ollamaVersion: version.version,
        details: show.details,
        capabilities: show.capabilities,
        limits,
      };
    },

    /** Unload, then load cold: what a restart of the AI container costs. */
    async coldLoad() {
      await call({
        path: "/api/generate",
        payload: { model: args.model, keep_alive: 0 },
      });
      const startedAt = Date.now();
      const json = await call({
        path: "/api/generate",
        payload: { model: args.model, keep_alive: -1 },
      });
      return {
        wallMs: Date.now() - startedAt,
        loadMs: json.load_duration ? json.load_duration / 1e6 : null,
      };
    },

    async analyze({ prompt, schema, imageBase64 }) {
      const startedAt = Date.now();
      const json = await call({
        path: "/api/chat",
        payload: {
          model: args.model,
          stream: false,
          think: false,
          keep_alive: -1,
          format: schema,
          options: {
            temperature: args.temperature,
            num_ctx: args.numCtx,
            num_predict: 500,
            seed: 42,
          },
          messages: [{ role: "user", content: prompt, images: [imageBase64] }],
        },
      });
      const wallMs = Date.now() - startedAt;
      const rawText = json.message?.content ?? "";

      return {
        rawText,
        wallMs,
        inputTokens: json.prompt_eval_count ?? null,
        outputTokens: json.eval_count ?? null,
        // Ollama reports the full prompt in prompt_eval_count even when most
        // of it came from the KV cache; the summary spots those calls by
        // their prefill rate (tokens / promptEvalMs) instead.
        metrics: {
          totalMs: json.total_duration / 1e6,
          loadMs: json.load_duration / 1e6,
          promptEvalMs: json.prompt_eval_duration / 1e6,
          evalMs: json.eval_duration / 1e6,
          doneReason: json.done_reason,
        },
      };
    },
  };
}

/**
 * Classical OCR (ocr-server/): the text lines become the product's answer
 * shape in ocr-rules.mjs, and evaluate.mjs scores that like any model answer.
 * The lines are kept in the record so hybrid.mjs can reuse them.
 */
async function ocrProvider(args) {
  const { answerFromOcr } = await import("./ocr-rules.mjs");
  // "combo": the receipt read by PP-OCRv5 mobile latin (handwritten dates),
  // the digits by PP-OCRv6 small without the direction classifier (LCD
  // segments); the task is known before the call, so each photo runs one.
  const COMBO = { proof: "v5-mobile", digits: "v6-small+nocls" };
  const profileFor = (item) =>
    args.model === "combo"
      ? item.task === "proof"
        ? COMBO.proof
        : COMBO.digits
      : args.model;
  const call = async (urlPath, payload) => {
    const response = await fetch(`${args.ocrUrl}${urlPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    const json = await response.json();
    if (!response.ok || json.error)
      throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  };

  return {
    async describe() {
      let limits = null;
      try {
        const { stdout } = await run("docker", [
          "inspect",
          "--format",
          "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.Config.Image}}",
          args.container,
        ]);
        const [nanoCpus, memory, image] = stdout.trim().split("|");
        limits = {
          cpus: Number(nanoCpus) / 1e9,
          memoryBytes: Number(memory),
          image,
        };
      } catch {
        // not a local container
      }
      return {
        engine: "rapidocr 3.9.2 + onnxruntime 1.30.0",
        profile: args.model,
        limits,
      };
    },

    /** Rebuilds the engine (ONNX sessions): what a restart costs. */
    async coldLoad() {
      const startedAt = Date.now();
      const profiles =
        args.model === "combo" ? Object.values(COMBO) : [args.model];
      let loadMs = 0;
      for (const profile of profiles)
        loadMs += (await call("/load", { profile })).loadMs;
      return { wallMs: Date.now() - startedAt, loadMs };
    },

    async analyze({ imageBase64, item, kind }) {
      const startedAt = Date.now();
      const json = await call("/ocr", {
        profile: profileFor(item),
        image: imageBase64,
      });
      const wallMs = Date.now() - startedAt;
      const { answer, covered } = answerFromOcr(item, kind, json.lines);

      return {
        rawText: JSON.stringify(answer),
        wallMs,
        inputTokens: null,
        outputTokens: null,
        ocrCovered: covered,
        ocrLines: json.lines.map((line) => ({
          text: line.text,
          score: Number(line.score.toFixed(3)),
          box: line.box.map((point) => point.map(Math.round)),
        })),
        metrics: { inferMs: json.inferMs },
      };
    },
  };
}

/**
 * The product's reader (ADR 0010): the trajetto-ai service (infra/ai-ocr)
 * over its v1 contract — the photo as raw bytes, the bearer token — and the
 * product's own OCR rules, loaded from source. A kind the product does not
 * read (fuel gauge, tyre, "working" items) is answered "not covered" without
 * a call, as the product creates no unit for it.
 */
async function localProvider(args) {
  const { loadProductOcrRules } = await import("./product-source.mjs");
  const rules = loadProductOcrRules();
  const token = readEnvKey(args.tokenEnv);
  if (!token)
    throw new Error(`${args.tokenEnv} not set (env or trajetto-api/.env)`);

  const { timeout } = productClientSettings();
  const uncovered = {
    fuel_level: {
      nivel_estimado: "ilegivel",
      confianca: 0,
      observacao: "OCR não cobre",
    },
    condition: {
      condicao_observada: "nao_sei",
      confianca: 0,
      observacao: "OCR não cobre",
    },
    working: { item_ok: "nao_sei", confianca: 0, observacao: "OCR não cobre" },
  };

  return {
    async describe() {
      let limits = null;
      try {
        const { stdout } = await run("docker", [
          "inspect",
          "--format",
          "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.Config.Image}}",
          args.container,
        ]);
        const [nanoCpus, memory, image] = stdout.trim().split("|");
        limits = {
          cpus: Number(nanoCpus) / 1e9,
          memoryBytes: Number(memory),
          image,
        };
      } catch {
        // not a local container
      }
      const health = await fetch(`${args.localUrl}/health`)
        .then((response) => response.json())
        .catch(() => null);
      return {
        service: "trajetto-ai",
        health,
        rulesVersion: rules.OCR_RULES_VERSION,
        limits,
      };
    },

    async coldLoad() {
      // The service loads both profiles at boot (/health is 200 after it).
      return null;
    },

    async analyze({ imageBase64, item, kind }) {
      const reads =
        item.task === "proof"
          ? "proof"
          : kind === "odometer"
            ? "odometer"
            : null;

      if (!reads) {
        return {
          rawText: JSON.stringify(uncovered[kind]),
          wallMs: 0,
          inputTokens: null,
          outputTokens: null,
          ocrCovered: false,
          metrics: {},
        };
      }

      const profile = reads === "proof" ? "receipt" : "digits";
      const startedAt = Date.now();
      const response = await fetch(
        `${args.localUrl}/v1/read?profile=${profile}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "image/jpeg",
          },
          body: Buffer.from(imageBase64, "base64"),
          signal: AbortSignal.timeout(timeout),
        },
      );
      const wallMs = Date.now() - startedAt;
      const json = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(`HTTP ${response.status} ${json.error ?? ""}`.trim());

      const answer =
        reads === "proof"
          ? rules.proofFromLines(json.lines)
          : rules.odometerFromLines(json.lines);

      return {
        rawText: JSON.stringify(answer),
        wallMs,
        inputTokens: null,
        outputTokens: null,
        ocrCovered: true,
        ocrLines: json.lines.map((line) => ({
          text: line.text,
          score: Number(line.score.toFixed(3)),
          box: line.box.map((point) => point.map(Math.round)),
        })),
        metrics: { inferMs: json.inferMs, queueMs: json.queueMs },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Optional downscale (e.g. --max-side 896) to measure the image-size knob.
// ---------------------------------------------------------------------------

async function downscaler(maxSide) {
  if (!maxSide) return null;
  const { createRequire } = await import("node:module");
  const candidates = [
    import.meta.url,
    path.resolve(apiRoot, "../trajetto-ui/package.json"),
  ];
  let playwright = null;
  for (const candidate of candidates) {
    try {
      playwright = createRequire(candidate)("playwright");
      break;
    } catch {
      // next
    }
  }
  if (!playwright) throw new Error("--max-side needs playwright (see README)");

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();

  return {
    async resize(base64) {
      return page.evaluate(
        async ({ data, side }) => {
          const img = new Image();
          img.src = `data:image/jpeg;base64,${data}`;
          await img.decode();
          const scale = Math.min(
            1,
            side / Math.max(img.naturalWidth, img.naturalHeight),
          );
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          canvas
            .getContext("2d")
            .drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
        },
        { data: base64, side: maxSide },
      );
    },
    close: () => browser.close(),
  };
}

// ---------------------------------------------------------------------------

/**
 * What is left to run. Variant-major order: two prompts about the same photo
 * back to back let Ollama reuse the image's KV cache, and the second one
 * would look 3x faster than any real request (the product analyzes each
 * photo once). Only answered calls count as done: a call that failed in
 * transport (timeout, 429, 529) is retried on resume, or it would stay a
 * permanent hole in the run.
 */
function pendingJobs(labels, { variants, only }, previousRecords) {
  const done = new Set(
    previousRecords
      .filter((record) => !record.error)
      .map((record) => `${record.id}:${record.variant}`),
  );

  const jobs = [];
  for (const variant of variants) {
    for (const item of labels) {
      if (only && !only.has(item.id)) continue;
      if (!(VARIANT_TASKS[variant] ?? []).includes(item.task)) continue;
      if (!done.has(`${item.id}:${variant}`)) jobs.push({ item, variant });
    }
  }

  return jobs;
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const labels = JSON.parse(
    fs.readFileSync(path.join(args.dataset, "labels.json"), "utf8"),
  );
  fs.mkdirSync(args.out, { recursive: true });
  const resultsFile = path.join(args.out, "results.jsonl");
  const samplesFile = path.join(args.out, "samples.jsonl");

  const jobs = pendingJobs(labels, args, readRecords(resultsFile));

  // Prompts are built before anything is timed, by the product's own code
  // (prompts.mjs). Ollama is held to the product's JSON schema of each
  // answer, so a prompt that gained or lost a key must stop the run until the
  // schema follows it; the OCR paths send no prompt at all.
  for (const job of jobs)
    job.request = await buildRequest(job.item, job.variant);

  const drift =
    args.provider === "ollama"
      ? [
          ...new Set(
            jobs.flatMap(({ item, variant, request }) =>
              schemaDrift(
                request.prompt,
                request.schema,
                `${item.task}${item.input?.fieldName ? `/${item.input.fieldName}` : ""} (${variant})`,
              ),
            ),
          ),
        ]
      : [];

  if (drift.length > 0 && !args.allowDrift) {
    throw new Error(
      `the answer schemas in src/shared/ai/ai-prompts.ts no longer match the prompts (update ANSWER_JSON_SCHEMAS):\n${drift.join("\n")}`,
    );
  }

  const provider =
    args.provider === "local"
      ? await localProvider(args)
      : args.provider === "ocr"
        ? await ocrProvider(args)
        : ollamaProvider(args);
  const local =
    args.provider === "ollama" ||
    args.provider === "ocr" ||
    args.provider === "local";
  const resizer = await downscaler(args.maxSide);
  const runInfoFile = path.join(args.out, "run.json");
  const runInfo = fs.existsSync(runInfoFile)
    ? JSON.parse(fs.readFileSync(runInfoFile, "utf8"))
    : {
        provider: args.provider,
        model: args.model,
        container: local ? args.container : null,
        variants: args.variants,
        temperature:
          args.provider === "ollama"
            ? args.temperature
            : "default (product sends none)",
        numCtx: args.provider === "ollama" ? args.numCtx : null,
        maxSide: args.maxSide ?? "as captured (<= 1600)",
        startedAt: new Date().toISOString(),
        host: {
          platform: process.platform,
          cpus: os.cpus().length,
          cpuModel: os.cpus()[0]?.model,
          totalMemBytes: os.totalmem(),
          node: process.version,
        },
        describe: await provider.describe(),
        segments: [],
      };

  const sampler = startSampler({
    container: args.container,
    samplesFile,
    enabled: local,
  });
  // The exact command of every segment (a resumed run can use other flags),
  // so any number in the report can be traced back and repeated.
  const segment = {
    startedAt: new Date().toISOString(),
    argv,
    jobs: jobs.length,
  };
  if (drift.length > 0) segment.allowedDrift = drift;

  if (local && jobs.length > 0) {
    segment.coldLoad = await provider.coldLoad();
    console.log(`cold load: ${JSON.stringify(segment.coldLoad)}`);
  }

  let index = 0;
  for (const { item, variant, request } of jobs) {
    index += 1;
    const { prompt, schema, kind } = request;
    let imageBase64 = fs
      .readFileSync(path.join(args.dataset, item.file))
      .toString("base64");
    if (resizer) imageBase64 = await resizer.resize(imageBase64);

    const record = {
      id: item.id,
      task: item.task,
      variant,
      provider: args.provider,
      model: args.model,
      at: new Date().toISOString(),
      // Identifies the exact prompt measured, to compare runs made weeks apart.
      promptSha256: sha256(prompt),
    };

    try {
      const answer = await provider.analyze({
        prompt,
        schema,
        imageBase64,
        item,
        kind,
      });
      Object.assign(record, answer);
      try {
        record.parsed = parseLikeProduct(answer.rawText);
        record.jsonValid = true;
      } catch (error) {
        record.jsonValid = false;
        record.parseError = String(error.message).slice(0, 300);
      }
    } catch (error) {
      record.error = String(error.message).slice(0, 300);
      record.jsonValid = false;
    }

    fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
    console.log(
      `[${index}/${jobs.length}] ${item.id}:${variant} ${record.error ? `ERROR ${record.error}` : `${(record.wallMs / 1000).toFixed(1)}s in=${record.inputTokens} out=${record.outputTokens} json=${record.jsonValid}`}`,
    );
  }

  segment.finishedAt = new Date().toISOString();
  const samples = await sampler.stop();
  segment.samples = samples.length;
  runInfo.segments.push(segment);
  fs.writeFileSync(runInfoFile, `${JSON.stringify(runInfo, null, 2)}\n`);
  if (resizer) await resizer.close();
}

function isEntryPoint() {
  if (!process.argv[1]) return false;

  const normalize = (file) =>
    process.platform === "win32"
      ? path.resolve(file).toLowerCase()
      : path.resolve(file);

  return (
    normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))
  );
}

// Imported by the tests for its pure helpers; runs only as a script.
if (isEntryPoint()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { parseMemoryStat, pendingJobs };
