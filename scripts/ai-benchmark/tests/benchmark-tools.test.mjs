/**
 * The benchmark's own guarantees, exercised through its CLIs the way the
 * README runs them (tsx, a real HTTP provider, real files).
 *
 * Every test builds a throwaway tree that mirrors trajetto-api —
 * scripts/ai-benchmark/*.mjs next to src/shared/ai/*.ts — so the product
 * files can be changed there (a new prompt line, a changed rule) without
 * touching the real ones. AI_BENCH_SCRIPTS_DIR points the copy at another
 * version of the scripts, to show these tests fail on it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { schemaDrift } from "../prompts.mjs";
import { parseMemoryStat } from "../run-benchmark.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const benchDir = path.resolve(here, "..");
const apiRoot = path.resolve(benchDir, "../..");
const scriptsUnderTest = process.env.AI_BENCH_SCRIPTS_DIR
  ? path.resolve(process.env.AI_BENCH_SCRIPTS_DIR)
  : benchDir;
const tsxCli = createRequire(path.join(apiRoot, "package.json")).resolve(
  "tsx/cli",
);

const PRODUCT_FILES = [
  "ai-prompts.ts",
  "ai-provider-defaults.ts",
  "ai-answers.ts",
  "provider-failure.ts",
  "ai-rules.ts",
  "ai-types.ts",
  "proof-criteria.ts",
];
const TIMEOUT = 90_000;

// --- throwaway tree -----------------------------------------------------------

const trees = [];

function makeTree(mutations = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trajetto-ai-bench-test-"),
  );
  trees.push(root);

  const scripts = path.join(root, "scripts/ai-benchmark");
  const ai = path.join(root, "src/shared/ai");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(ai, { recursive: true });

  for (const file of fs.readdirSync(scriptsUnderTest)) {
    if (file.endsWith(".mjs"))
      fs.copyFileSync(
        path.join(scriptsUnderTest, file),
        path.join(scripts, file),
      );
  }

  for (const file of PRODUCT_FILES) {
    let text = fs.readFileSync(
      path.join(apiRoot, "src/shared/ai", file),
      "utf8",
    );
    for (const [from, to] of mutations[file] ?? []) {
      // A fixture that silently stopped applying would prove nothing.
      if (!text.includes(from))
        throw new Error(`fixture anchor not found in ${file}: ${from}`);
      text = text.replace(from, to);
    }
    fs.writeFileSync(path.join(ai, file), text);
  }

  fs.copyFileSync(
    path.join(apiRoot, "package.json"),
    path.join(root, "package.json"),
  );
  fs.symlinkSync(
    path.join(apiRoot, "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );

  return root;
}

function removeTree(root) {
  // Unlink the junction first: the real node_modules must never be walked.
  const link = path.join(root, "node_modules");
  if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.rmSync(root, { recursive: true, force: true });
}

afterAll(() => {
  for (const root of trees.splice(0)) removeTree(root);
});

// --- fixtures -----------------------------------------------------------------

const RECEIPT = {
  expectedDocument: "45181",
  expectedRecipient: "Mercado Boa Vista Ltda",
  provenOn: "2026-09-27",
};

const LABELS = [
  {
    id: "O01",
    task: "odometer",
    file: "images/O01.jpg",
    description: "odômetro",
    input: { reportedMileage: 100000 },
    truth: { reading: 100060, expected: ["verified"] },
  },
  {
    id: "P01",
    task: "proof",
    file: "images/P01.jpg",
    description: "canhoto correto",
    input: RECEIPT,
    truth: {
      isReceipt: "yes",
      legible: "yes",
      hasSignature: "yes",
      dateVisible: "yes",
      documentMatches: "yes",
      printedNumber: "45181",
      expected: "looks_good",
    },
  },
  {
    id: "P08",
    task: "proof",
    file: "images/P08.jpg",
    description: "sem data de recebimento (só a data de emissão impressa)",
    input: RECEIPT,
    truth: {
      isReceipt: "yes",
      legible: "yes",
      hasSignature: "yes",
      dateVisible: "no",
      documentMatches: "yes",
      printedNumber: "45181",
      expected: "looks_wrong",
    },
  },
];

function makeDataset(root) {
  const dataset = path.join(root, "dataset");
  fs.mkdirSync(path.join(dataset, "images"), { recursive: true });
  for (const item of LABELS)
    fs.writeFileSync(
      path.join(dataset, item.file),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  fs.writeFileSync(path.join(dataset, "labels.json"), JSON.stringify(LABELS));
  return dataset;
}

function writeRun(runDir, records) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      provider: "ollama",
      model: "fake",
      describe: {},
      segments: [],
    }),
  );
  fs.writeFileSync(
    path.join(runDir, "results.jsonl"),
    records.map((r) => `${JSON.stringify(r)}\n`).join(""),
  );
}

const ODOMETER_ANSWER = {
  valor_lido: 100060,
  confianca: 90,
  legivel: true,
  sinais_fraude: false,
  motivos_fraude: [],
  observacao: "ok",
};
const PROOF_ANSWER = {
  e_canhoto: "sim",
  numero_documento_lido: "45181",
  data_recebimento_lida: "27/09/2026",
  tem_assinatura: "sim",
  nome_recebedor_lido: null,
  legivel: "sim",
  qualidade_foto: 0.9,
  confianca: 0.9,
  observacao: "ok",
};

// --- a fake Ollama that records what it was asked -------------------------------

let server;
let ollamaUrl;
const chats = [];

function fakeAnswer(format) {
  const answer = {};
  for (const [key, spec] of Object.entries(format?.properties ?? {})) {
    const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
    if (spec.enum) answer[key] = spec.enum[0];
    else if (type === "number") answer[key] = 0.9;
    else if (type === "boolean") answer[key] = true;
    else if (type === "array") answer[key] = [];
    else answer[key] = "ok";
  }
  return {
    ...answer,
    ...(format?.properties?.valor_lido ? ODOMETER_ANSWER : {}),
  };
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      const reply = (json) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };

      if (request.url === "/api/version") return reply({ version: "fake" });
      if (request.url === "/api/show")
        return reply({
          details: { quantization_level: "Q4_0" },
          capabilities: ["vision"],
        });
      if (request.url === "/api/generate")
        return reply({ load_duration: 1_000_000 });

      chats.push({
        prompt: payload.messages[0].content,
        format: payload.format,
      });
      return reply({
        message: { content: JSON.stringify(fakeAnswer(payload.format)) },
        prompt_eval_count: 1000,
        eval_count: 100,
        total_duration: 2e9,
        load_duration: 0,
        prompt_eval_duration: 1.5e9,
        eval_duration: 0.5e9,
        done_reason: "stop",
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

afterEach(() => {
  chats.length = 0;
});

async function runScript(root, script, args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxCli, path.join(root, "scripts/ai-benchmark", script), ...args],
      { cwd: root, timeout: TIMEOUT - 10_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function runBenchmark(root, out, extra) {
  return runScript(root, "run-benchmark.mjs", [
    "--provider",
    "ollama",
    "--model",
    "fake",
    "--dataset",
    path.join(root, "dataset"),
    "--out",
    out,
    "--ollama-url",
    ollamaUrl,
    "--container",
    "trajetto-ai-bench-test-missing",
    ...extra,
  ]);
}

async function summarize(root, runDir) {
  const json = path.join(root, `summary-${path.basename(runDir)}.json`);
  const result = await runScript(root, "summarize.mjs", [
    "--dataset",
    path.join(root, "dataset"),
    "--runs",
    runDir,
    "--json",
    json,
  ]);
  if (result.code !== 0) throw new Error(`summarize failed: ${result.stderr}`);
  return JSON.parse(fs.readFileSync(json, "utf8"))[0];
}

// --- prompts come from the product ---------------------------------------------

describe("prompts measured", () => {
  it(
    "sends the product's odometer prompt as it is on disk, a line the product just added included, and blind",
    async () => {
      const added = "Ignore reflexos no vidro do painel.";
      const root = makeTree({
        "ai-prompts.ts": [
          [
            '"Analise esta foto de odômetro de veículo.",',
            `"Analise esta foto de odômetro de veículo.",\n    "${added}",`,
          ],
        ],
      });
      makeDataset(root);
      const out = path.join(root, "run");
      const args = ["--variants", "prod", "--only", "O01"];

      const result = await runBenchmark(root, out, args);

      expect(result.code, result.stderr).toBe(0);
      expect(chats).toHaveLength(1);
      const [prod] = chats.map((chat) => chat.prompt);
      expect(prod).toContain(added);
      // Blind (ADR 0010): the reported mileage is nowhere in the prompt.
      expect(prod).not.toContain("100000");
      expect(prod).not.toContain("O motorista informou");

      // The exact command of the segment is kept, so the run can be repeated.
      const info = JSON.parse(
        fs.readFileSync(path.join(out, "run.json"), "utf8"),
      );
      expect(info.segments[0].argv).toEqual([
        "--provider",
        "ollama",
        "--model",
        "fake",
        "--dataset",
        path.join(root, "dataset"),
        "--out",
        out,
        "--ollama-url",
        ollamaUrl,
        "--container",
        "trajetto-ai-bench-test-missing",
        ...args,
      ]);
    },
    TIMEOUT,
  );

  it(
    "refuses an Ollama run while the product prompt asks for a key the JSON schema does not allow",
    async () => {
      const root = makeTree({
        "ai-prompts.ts": [
          [
            `'  "legivel": "sim" | "nao" | "nao_sei",',`,
            `'  "serie_lida": "sim" | "nao" | "nao_sei",',\n    '  "legivel": "sim" | "nao" | "nao_sei",',`,
          ],
        ],
      });
      makeDataset(root);

      const refused = await runBenchmark(root, path.join(root, "run"), [
        "--variants",
        "prod",
        "--only",
        "P01",
      ]);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("serie_lida");
      expect(chats).toHaveLength(0);

      // --allow-drift is the explicit override, and then the new line is sent.
      const allowed = await runBenchmark(root, path.join(root, "run-allowed"), [
        "--variants",
        "prod",
        "--only",
        "P01",
        "--allow-drift",
      ]);

      expect(allowed.code, allowed.stderr).toBe(0);
      expect(chats).toHaveLength(1);
      expect(chats[0].prompt).toContain('"serie_lida"');
    },
    TIMEOUT,
  );
});

// --- verdicts come from the product -----------------------------------------------

describe("verdict rules", () => {
  it(
    "scores with the product's current odometer rule, not a copy of an older one",
    async () => {
      // 60 km on 100,000 km: over the absolute threshold (50) and under the
      // relative one (5%). "&&" says verified; "||" says mismatch.
      const record = {
        id: "O01",
        task: "odometer",
        variant: "prod",
        wallMs: 1000,
        jsonValid: true,
        parsed: ODOMETER_ANSWER,
      };

      const original = makeTree();
      makeDataset(original);
      writeRun(path.join(original, "run"), [record]);

      const changed = makeTree({
        "ai-rules.ts": [
          [
            "diff > ODOMETER_MISMATCH_THRESHOLD_KM &&",
            "diff > ODOMETER_MISMATCH_THRESHOLD_KM ||",
          ],
        ],
      });
      makeDataset(changed);
      writeRun(path.join(changed, "run"), [record]);

      const [before, after] = await Promise.all([
        summarize(original, path.join(original, "run")),
        summarize(changed, path.join(changed, "run")),
      ]);

      expect(before.items[0].verdict).toBe("verified");
      expect(after.items[0].verdict).toBe("mismatch");
    },
    TIMEOUT,
  );

  it(
    "extraction: a date other than the delivery day (the printed EMISSÃO date) is not a receipt date",
    async () => {
      const extraction = (date) => ({
        e_canhoto: "sim",
        numero_documento_lido: "000.045.181",
        data_recebimento_lida: date,
        tem_assinatura: "sim",
        nome_recebedor_lido: null,
        legivel: "sim",
        qualidade_foto: 0.9,
        confianca: 0.9,
        observacao: "ok",
      });
      const root = makeTree();
      makeDataset(root);
      writeRun(path.join(root, "run"), [
        {
          id: "P01",
          task: "proof",
          variant: "extract",
          wallMs: 1000,
          jsonValid: true,
          parsed: extraction("27/09/26"),
        },
        {
          id: "P08",
          task: "proof",
          variant: "extract",
          wallMs: 1000,
          jsonValid: true,
          parsed: extraction("25/09/2026"),
        },
      ]);

      const summary = await summarize(root, path.join(root, "run"));
      const byId = Object.fromEntries(
        summary.items.map((item) => [item.id, item]),
      );

      expect(byId.P01).toMatchObject({ verdict: "looks_good", ok: true });
      expect(byId.P08).toMatchObject({ verdict: "looks_wrong", ok: true });
      expect(
        summary.accuracy.extract.proof.perCriterion.dateVisible,
      ).toMatchObject({ hits: 2, total: 2 });

      // The NF-e read is compared with the expected one, as the product does
      // for the inputs it builds (PROOF_INPUT_VERSION): an input without the
      // version is not compared, and "not_applicable" would miss both.
      expect(
        summary.accuracy.extract.proof.perCriterion.documentMatches,
      ).toMatchObject({ hits: 2, total: 2 });
    },
    TIMEOUT,
  );
});

// --- resume, errors and cache ------------------------------------------------------

describe("run bookkeeping", () => {
  it(
    "retries on resume a call that failed in transport, and the summary counts it once",
    async () => {
      const root = makeTree();
      makeDataset(root);
      const out = path.join(root, "run");
      writeRun(out, [
        {
          id: "O01",
          task: "odometer",
          variant: "prod",
          error: "529 overloaded_error",
          jsonValid: false,
        },
        {
          id: "P01",
          task: "proof",
          variant: "prod",
          wallMs: 1000,
          jsonValid: true,
          parsed: PROOF_ANSWER,
        },
      ]);
      fs.rmSync(path.join(out, "run.json"));

      const result = await runBenchmark(root, out, [
        "--variants",
        "prod",
        "--only",
        "O01,P01",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(chats).toHaveLength(1);
      expect(chats[0].prompt).toContain("odômetro");

      const summary = await summarize(root, out);
      expect(summary.calls).toBe(2);
      expect(summary.errors).toBe(0);
      expect(summary.jsonValid).toMatchObject({ hits: 2, total: 2 });
    },
    TIMEOUT,
  );

  it(
    "counts JSON validity over answered calls only; a transport error is not invalid JSON",
    async () => {
      const root = makeTree();
      makeDataset(root);
      writeRun(path.join(root, "run"), [
        {
          id: "P01",
          task: "proof",
          variant: "prod",
          wallMs: 1000,
          jsonValid: true,
          parsed: PROOF_ANSWER,
        },
        {
          id: "O01",
          task: "odometer",
          variant: "prod",
          error: "timeout",
          jsonValid: false,
        },
      ]);

      const summary = await summarize(root, path.join(root, "run"));

      expect(summary.errors).toBe(1);
      expect(summary.jsonValid).toMatchObject({ hits: 1, total: 1 });
    },
    TIMEOUT,
  );

  it(
    "flags a call whose prefill came from the KV cache by its prefill rate",
    async () => {
      const root = makeTree();
      makeDataset(root);
      // ~20 tok/s is a fresh image on 4 vCPU; 1145 tokens in 6.8 s (~169
      // tok/s) is the measured cache hit. prompt_eval_count is full in both.
      const fresh = (id, variant) => ({
        id,
        task: "proof",
        variant,
        wallMs: 60_000,
        jsonValid: true,
        parsed: PROOF_ANSWER,
        inputTokens: 1141,
        metrics: { promptEvalMs: 57_000, evalMs: 3000 },
      });
      writeRun(path.join(root, "run"), [
        fresh("P01", "prod"),
        fresh("P08", "prod"),
        fresh("P08", "extract"),
        {
          ...fresh("P01", "extract"),
          wallMs: 22_000,
          inputTokens: 1145,
          metrics: { promptEvalMs: 6_770, evalMs: 3000 },
        },
      ]);

      const summary = await summarize(root, path.join(root, "run"));

      expect(summary.latency.all.cacheHitSuspects).toBe(1);
    },
    TIMEOUT,
  );
});

// --- pure helpers -------------------------------------------------------------------

describe("helpers", () => {
  it("reads anon and file memory from a cgroup v2 memory.stat (captured from a container)", () => {
    const stat =
      "anon 3067904\nfile 7413760\nkernel 1003520\nfile_mapped 3289088\n";

    expect(parseMemoryStat(stat)).toEqual({
      anonBytes: 3067904,
      fileBytes: 7413760,
    });
    expect(parseMemoryStat("total_rss 10\ntotal_cache 20\n")).toEqual({
      anonBytes: 10,
      fileBytes: 20,
    });
    expect(parseMemoryStat("not a stat file")).toBeNull();
  });

  it("schemaDrift reports keys and choices that differ in either direction", () => {
    const prompt = 'Responda APENAS em JSON: { "a": "x" | "y", "b": number }';

    expect(
      schemaDrift(prompt, {
        properties: { a: { enum: ["y", "x"] }, b: {} },
        required: ["a", "b"],
      }),
    ).toEqual([]);
    expect(
      schemaDrift(prompt, {
        properties: { a: { enum: ["x"] }, b: {}, c: {} },
        required: ["a", "b"],
      }),
    ).toEqual([
      'prompt: "a" allows ["x","y"] in the prompt and ["x"] in the Ollama schema',
      'prompt: the Ollama schema has "c", the prompt no longer asks for it',
    ]);
  });
});
