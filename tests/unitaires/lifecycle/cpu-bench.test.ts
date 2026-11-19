import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The CPU bench (plano-escala LOAD-10): cpu-abba.sh alternates two images
 * of the API on the harness in ABBAAB and reports CPU and statements per
 * request; cpu-profile.sh profiles the replicas under load and prints the
 * top. The 8.14 ms and 10.68 statements of the ADR 0011 came from this
 * method done by hand; the wave 15 target (≤ 6 ms, ≤ 7 statements) and
 * every cut of F4-07 are judged by it.
 *
 * The libraries are imported and fed numbers; the scripts are executed for
 * real, with docker replaced by a stub that keeps the harness' state (the
 * image of the replicas, the CPU counters of each cgroup, the model
 * database), so the order of the runs, the fresh copy of the database
 * before each and the restore of the profiler are what ran, not what the
 * text says.
 */
const ROOT = process.cwd();
const LIB = resolve(ROOT, "tests", "load", "lib");

type Summary = Record<string, unknown>;

async function abba() {
  return (await import(pathToFileURL(join(LIB, "abba-report.mjs")).href)) as {
    runFacts: (
      run: Record<string, unknown>,
      summary: Summary,
    ) => Record<string, number | null>;
    judge: (
      meta: Record<string, unknown>,
      facts: Record<string, unknown>[],
    ) => { kind: string; passed: boolean; control: boolean; lines: string[] };
    renderAbbaReport: (work: unknown) => { markdown: string; passed: boolean };
    reportName: (dir: string, date: string, label: string) => string;
    stats: (
      values: number[],
    ) => { mean: number; stdev: number; n: number } | null;
  };
}

async function top() {
  return (await import(
    pathToFileURL(join(LIB, "cpuprofile-top.mjs")).href
  )) as {
    analyze: (
      profiles: unknown[],
      options?: Record<string, unknown>,
    ) => {
      cpuMs: number;
      idleMs: number;
      gcShare: number;
      perRequestMs: number | null;
      match: { share: number } | null;
      packages: { name: string; ms: number }[];
      self: { name: string; location: string; ms: number; share: number }[];
      total: { name: string; ms: number }[];
    };
    renderTop: (result: unknown) => string;
    parseArgs: (argv: string[]) => unknown;
  };
}

const summary = (requests: number, p95 = 45, failures = 0): Summary => ({
  metrics: {
    http_reqs: { count: requests, rate: requests / 120 },
    http_req_duration: { med: 20, "p(95)": p95, "p(99)": 60 },
    surface_failures: { value: failures },
  },
});

const runOf = (n: number, variant: string, apiMs: number, calls: number) => ({
  n,
  variant,
  image: `img:${variant.toLowerCase()}`,
  replicas: 2,
  role: "all",
  cpuset: "",
  k6Exit: 0,
  wallSeconds: 120,
  idle: { seconds: 0, apiUsec: 0, calls: 0 },
  cpu: { apiUsec: apiMs * 1000, postgresUsec: 1_000_000 },
  pgss: { calls, execMs: 30_000, rows: 5_000 },
  apiMemoryBytes: 300 * 1024 * 1024,
});

const META = {
  label: "controle",
  order: "ABBAAB",
  aImage: "img:a",
  aId: "sha256:aaaa",
  bImage: "img:b",
  bId: "sha256:aaaa",
  rate: 60,
  durationSeconds: 120,
  warmupSeconds: 20,
  idleSeconds: 15,
  commit: "0123456789ab",
  host: "bancada",
  nproc: "12",
  dockerCpus: "12",
  template: "abba 2026-11-18T10:00Z",
  date: "2026-11-18",
};

/** ABBAAB with the CPU of each variant per request (ms) over 1000 requests. */
async function session(
  a: number[],
  b: number[],
  options: { p95B?: number; failuresAt?: number } = {},
) {
  const { runFacts } = await abba();
  const order = "ABBAAB".split("");
  let ia = 0;
  let ib = 0;

  return order.map((variant, index) => {
    const ms = variant === "A" ? a[ia++] : b[ib++];
    const facts = runFacts(
      runOf(index + 1, variant, ms * 1000, 10_680),
      summary(
        1000,
        variant === "B" ? (options.p95B ?? 45) : 45,
        options.failuresAt === index + 1 ? 0.02 : 0,
      ),
    );

    return facts;
  });
}

describe("the ABBA report (LOAD-10)", () => {
  it("divides the window's CPU and statements by k6's requests, and nets the idle", async () => {
    const { runFacts } = await abba();
    const facts = runFacts(
      {
        ...runOf(1, "A", 8_140, 10_680),
        idle: { seconds: 10, apiUsec: 100_000, calls: 200 },
      },
      summary(1000),
    );

    expect(facts.cpuMs).toBeCloseTo(8.14, 5);
    expect(facts.statements).toBeCloseTo(10.68, 5);
    // 10 ms/s and 20 statements/s of background over the 120 s window.
    expect(facts.netCpuMs).toBeCloseTo(
      (8_140_000 - 1_200_000) / 1000 / 1000,
      5,
    );
    expect(facts.netStatements).toBeCloseTo((10_680 - 2_400) / 1000, 5);
    expect(facts.postgresCpuMs).toBeCloseTo(1, 5);
    expect(facts.p95).toBe(45);
  });

  it("has no per-request number for a run without requests", async () => {
    const { runFacts } = await abba();
    const facts = runFacts(runOf(1, "A", 8_000, 10_000), summary(0));

    expect(facts.cpuMs).toBeNull();
    expect(facts.statements).toBeNull();
  });

  it("calls the bench reliable when A=B differ by less than 5%", async () => {
    const { judge } = await abba();
    const verdict = judge(
      META,
      await session([8.1, 8.2, 8.15], [8.2, 8.1, 8.3]),
    );

    expect(verdict.kind).toBe("controle");
    expect(verdict.passed).toBe(true);
    expect(verdict.lines[0]).toContain("A bancada mede");
  });

  it("calls it noisy when A=B differ by 5% or more", async () => {
    const { judge } = await abba();
    const verdict = judge(META, await session([8, 8, 8], [8.5, 8.4, 8.5]));

    expect(verdict.passed).toBe(false);
    expect(verdict.lines[0]).toContain("ruidosa demais");
  });

  it("keeps a cut only from 2% less CPU and with the p95 at most 5% worse", async () => {
    const { judge } = await abba();
    const cut = { ...META, bId: "sha256:bbbb", label: "corte" };

    const kept = judge(cut, await session([8, 8, 8], [7.8, 7.8, 7.8]));
    const tooSmall = judge(cut, await session([8, 8, 8], [7.9, 7.9, 7.9]));
    const slower = judge(
      cut,
      await session([8, 8, 8], [7, 7, 7], { p95B: 48 }),
    );

    expect([kept.kind, kept.passed]).toEqual(["corte", true]);
    expect(tooSmall.passed).toBe(false);
    expect(slower.passed).toBe(false);
    expect(slower.lines[0]).toContain("O corte sai");
  });

  it("says whether B reached the wave 15 target, as indicative", async () => {
    const { judge } = await abba();
    const cut = { ...META, bId: "sha256:bbbb" };

    const reached = judge(cut, await session([8, 8, 8], [5.9, 5.9, 5.9]));
    const missed = judge(cut, await session([8, 8, 8], [7.5, 7.5, 7.5]));

    // 10.68 statements per request: not reached even at 5.9 ms.
    expect(reached.lines[1]).toContain("não, com 5,90 ms e 10,68 statements");
    expect(missed.lines[1]).toContain("Indicativo na bancada");
  });

  it("is invalid with a run that failed 1% of its requests, or out of order", async () => {
    const { judge } = await abba();

    const failed = judge(
      META,
      await session([8, 8, 8], [8, 8, 8], { failuresAt: 3 }),
    );
    const shuffled = judge(
      { ...META, order: "AABBAB" },
      await session([8, 8, 8], [8, 8, 8]),
    );

    expect([failed.kind, failed.passed]).toEqual(["inválido", false]);
    expect(failed.lines[0]).toContain("a corrida 3 falhou 2,0%");
    expect(shuffled.lines[0]).toContain("não seguem a ordem AABBAB");
  });

  it("writes the report with the commit, both images, the verdict and every run", async () => {
    const { renderAbbaReport } = await abba();
    const runs = "ABBAAB".split("").map((variant, index) => ({
      run: runOf(index + 1, variant, 8_000_000 / 1000, 10_680),
      summary: summary(1000),
      top: [["6000", "120.5", "SELECT a | b FROM `x`"]],
    }));
    const { markdown, passed } = renderAbbaReport({ meta: META, runs });

    expect(passed).toBe(true);
    expect(markdown).toContain("| Resultado | bancada confiável |");
    expect(markdown).toContain("| Commit do harness | 0123456789ab |");
    expect(markdown).toContain("| A | img:a (aaaa) |");
    expect(markdown).toContain("| Controle (A=B) | sim |");
    expect(markdown).toContain(
      "| CPU da api por requisição | 8,00 ± 0,00 ms | 8,00 ± 0,00 ms | 0,0% |",
    );
    expect(markdown).toContain("| 6 | B | 1.000 | 8,00 ms | 10,68 |");
    // A pipe in a statement would split the table's row.
    expect(markdown).toContain("`SELECT a \\| b FROM 'x'`");
  });

  it("names a second session of the day -2", async () => {
    const { reportName } = await abba();
    const dir = mkdtempSync(join(tmpdir(), "trajetto-abba-"));

    try {
      expect(reportName(dir, "2026-11-18", "abba")).toBe("2026-11-18-abba.md");
      writeFileSync(join(dir, "2026-11-18-abba.md"), "");
      expect(reportName(dir, "2026-11-18", "abba")).toBe(
        "2026-11-18-abba-2.md",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A profile in V8's format: a root, idle and the frames, sampled at times. */
function profileOf(
  frames: { name: string; url: string; parent?: string }[],
  timeline: [string, number, number, number][],
  endUs: number,
) {
  const ids = new Map<string, number>([["(root)", 1]]);

  frames.forEach((frame, index) => ids.set(frame.name, index + 2));

  const nodes = [
    {
      id: 1,
      callFrame: { functionName: "(root)", url: "", lineNumber: -1 },
      children: frames
        .filter((frame) => !frame.parent)
        .map((frame) => ids.get(frame.name)),
    },
    ...frames.map((frame) => ({
      id: ids.get(frame.name),
      callFrame: { functionName: frame.name, url: frame.url, lineNumber: 9 },
      children: frames
        .filter((other) => other.parent === frame.name)
        .map((other) => ids.get(other.name)),
    })),
  ];

  const samples: number[] = [];
  const stamps: number[] = [];

  // [frame, from µs, to µs, every µs]
  for (const [name, from, to, every] of timeline) {
    for (let at = from; at < to; at += every) {
      samples.push(ids.get(name)!);
      stamps.push(at);
    }
  }

  const order = stamps
    .map((_, index) => index)
    .sort((a, b) => stamps[a] - stamps[b]);
  const sorted = order.map((index) => stamps[index]);

  return {
    nodes,
    startTime: 0,
    endTime: endUs,
    samples: order.map((index) => samples[index]),
    timeDeltas: sorted.map(
      (stamp, index) => stamp - (index === 0 ? 0 : sorted[index - 1]),
    ),
  };
}

const APP = "file:///app/build/server.js";
const FRAMES = [
  { name: "(idle)", url: "" },
  { name: "(garbage collector)", url: "" },
  { name: "bootStuff", url: APP },
  { name: "handler", url: APP },
  { name: "loadSession", url: APP, parent: "handler" },
  {
    name: "serialize",
    url: "file:///app/node_modules/fast-json-stringify/index.js",
    parent: "handler",
  },
  { name: "shutdownStuff", url: APP },
];

/** Boot in the first second, 10 s of load, idle between, shutdown at the end. */
const LOADED = profileOf(
  FRAMES,
  [
    ["bootStuff", 0, 1_000_000, 1000],
    ["(idle)", 1_000_000, 5_000_000, 1000],
    ["loadSession", 5_000_000, 15_000_000, 4000],
    ["serialize", 5_001_000, 15_000_000, 4000],
    ["handler", 5_002_000, 15_000_000, 4000],
    ["(garbage collector)", 5_003_000, 15_000_000, 4000],
    ["shutdownStuff", 15_000_000, 16_000_000, 1000],
  ],
  16_000_000,
);

describe("the CPU profile's top (LOAD-10)", () => {
  it("counts only the window: the boot before it and the shutdown after it stay out", async () => {
    const { analyze } = await top();
    const result = analyze([LOADED], {
      lastSeconds: 10,
      skipTailSeconds: 1,
      top: 10,
    });
    const names = result.self.map((row) => row.name);

    expect(names).not.toContain("bootStuff");
    expect(names).not.toContain("shutdownStuff");
    expect(result.cpuMs).toBeCloseTo(10_000, 0);
    expect(
      result.self.find((row) => row.name === "loadSession")?.share,
    ).toBeCloseTo(25, 1);
  });

  it("leaves the idle out of the CPU and keeps the garbage collector in", async () => {
    const { analyze } = await top();
    const result = analyze([LOADED], {});

    expect(result.idleMs).toBeCloseTo(4_000, 0);
    expect(result.cpuMs).toBeCloseTo(1_000 + 10_000 + 1_000, 0);
    expect(result.gcShare).toBeGreaterThan(0);
  });

  it("charges a caller with what it calls, once per sample", async () => {
    const { analyze } = await top();
    const result = analyze([LOADED], { lastSeconds: 10, skipTailSeconds: 1 });
    const handler = result.total.find((row) => row.name === "handler");

    // Its own quarter plus loadSession's and serialize's.
    expect(handler?.ms).toBeCloseTo(7_500, 0);
  });

  it("groups the self time by package and measures the share under a pattern", async () => {
    const { analyze } = await top();
    const result = analyze([LOADED], {
      lastSeconds: 10,
      skipTailSeconds: 1,
      match: "loadSession|ensureAuthenticated",
      requests: 1000,
    });

    expect(result.packages.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "fast-json-stringify",
        "aplicação (build/server.js)",
        "(coletor de lixo)",
      ]),
    );
    expect(result.match?.share).toBeCloseTo(25, 1);
    expect(result.perRequestMs).toBeCloseTo(10, 1);
  });

  it("merges the replicas' profiles", async () => {
    const { analyze } = await top();
    const one = analyze([LOADED], { lastSeconds: 10, skipTailSeconds: 1 });
    const two = analyze([LOADED, LOADED], {
      lastSeconds: 10,
      skipTailSeconds: 1,
    });

    expect(two.cpuMs).toBeCloseTo(one.cpuMs * 2, 0);
  });

  it("reads a real profile of node --cpu-prof", async () => {
    const { analyze, renderTop } = await top();
    const dir = mkdtempSync(join(tmpdir(), "trajetto-cpuprof-"));

    try {
      const node = spawnSync(
        process.execPath,
        [
          "--cpu-prof",
          `--cpu-prof-dir=${dir}`,
          "-e",
          "function burnTheCpu(){let x=0;for(let i=0;i<4e7;i++)x+=i%7;return x}setTimeout(()=>{burnTheCpu();process.exit(0)},50)",
        ],
        { encoding: "utf8" },
      );

      expect(node.status, node.stderr).toBe(0);

      const [file] = readdirSync(dir).filter((name) =>
        name.endsWith(".cpuprofile"),
      );
      const result = analyze(
        [JSON.parse(readFileSync(join(dir, file), "utf8"))],
        { top: 5 },
      );

      expect(result.self[0].name).toBe("burnTheCpu");
      expect(renderTop(result)).toContain("| 1 | burnTheCpu |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an option it does not know and a call without profiles", async () => {
    const { parseArgs } = await top();

    expect(() => parseArgs(["--lst", "10", "a.cpuprofile"])).toThrow(
      "opção desconhecida",
    );
    expect(() => parseArgs(["--top", "5"])).toThrow("nenhum perfil");
  });
});

const bash = hasShell("bash");

/**
 * docker, as the harness answers it. State lives in STUB_STATE: the image
 * the api was last recreated with, whether the replicas are stopped, a CPU
 * counter per container (each read of cpu.stat advances it by the step of
 * the current image), and the model database once created.
 */
const DOCKER = `
state="$STUB_STATE"
case "$1" in
  context) echo "\${STUB_ENDPOINT:-npipe:////./pipe/docker_engine}" ;;
  info)
    case "$*" in
      *LocalNodeState*) echo "\${STUB_SWARM:-inactive}" ;;
      *NCPU*) echo 12 ;;
    esac ;;
  service) printf '%s' "\${STUB_SERVICES:-}" ;;
  image)
    for last; do :; done
    case "$last" in
      img:a) echo "\${STUB_ID_A:-sha256:aaaaaaaaaaaaaaaa}" ;;
      img:b) echo "\${STUB_ID_B:-sha256:aaaaaaaaaaaaaaaa}" ;;
      *) exit 1 ;;
    esac ;;
  ps)
    case "$*" in
      *service=api*) [ -f "$state/api-down" ] || printf 'api1\\napi2\\n' ;;
      *service=postgres*) echo pg1 ;;
      *service=redis*) echo r1 ;;
      *service=worker*) [ -z "\${STUB_WORKER:-}" ] || echo w1 ;;
    esac ;;
  stop) for c in "$@"; do case "$c" in api*) touch "$state/api-down" ;; esac; done ;;
  start) ;;
  inspect)
    case "$*" in *CpusetCpus*) echo "0-5" ;; *) echo "PROCESS_ROLE=all" ;; esac ;;
  cp)
    for dest; do :; done
    cp "$STUB_PROFILE" "$dest/CPU.big.cpuprofile"
    printf '{"nodes":[],"samples":[],"timeDeltas":[],"startTime":0,"endTime":1}' > "$dest/CPU.small.cpuprofile" ;;
  exec)
    c="$2"
    case "$*" in
      *cpu.stat*)
        case "$c" in
          api*)
            image="$(cat "$state/image" 2>/dev/null)"
            if [ "$image" = img:b ]; then step="\${STUB_STEP_B:-4000000}"; else step="\${STUB_STEP_A:-4000000}"; fi ;;
          *) step=1000000 ;;
        esac
        now=$(( $(cat "$state/cpu-$c" 2>/dev/null || echo 0) + step ))
        echo "$now" > "$state/cpu-$c"
        printf 'usage_usec %s\\nuser_usec %s\\nsystem_usec 0\\n' "$now" "$now" ;;
      *memory.current*) echo 314572800 ;;
      *wget*) ;;
      *redis-cli*) echo OK ;;
      *shared_preload_libraries*) echo pg_stat_statements ;;
      *pg_stat_statements_reset*) ;;
      *"sum(calls)"*) echo "\${STUB_CALLS:-10680} 30100.5 5000" ;;
      *"ORDER BY calls"*) printf '6000\\t120.5\\tSELECT 1\\n' ;;
      *shobj_description*) echo "abba 2026-11-18T10:00Z" ;;
      *"CREATE DATABASE load_abba_template"*) touch "$state/template" ;;
      *"datname = 'load_abba_template'"*)
        if [ -f "$state/template" ] || [ -n "\${STUB_TEMPLATE:-}" ]; then echo 1; fi ;;
      *"SELECT 1 FROM pg_database WHERE datname = 'load_test'"*) echo 1 ;;
    esac ;;
  compose)
    case "$*" in
      *" up "*)
        echo "\${LOAD_API_IMAGE:-}" > "$state/image"
        echo "\${LOAD_API_IMAGE:-}" >> "$state/ups"
        echo "\${LOAD_API_NODE_FLAGS-unset}" >> "$state/flags"
        rm -f "$state/api-down" ;;
      *" run "*)
        [ -z "\${STUB_K6_EXIT:-}" ] || exit "$STUB_K6_EXIT"
        dir=""; out=""; prev=""
        for a in "$@"; do
          case "$a" in *:/results) dir="\${a%:/results}" ;; esac
          [ "$prev" != "--summary-export" ] || out="\${a#/results/}"
          prev="$a"
        done
        printf '{"metrics":{"http_reqs":{"count":%s,"rate":8.3},"http_req_duration":{"med":20,"p(95)":45,"p(99)":60},"surface_failures":{"value":0}}}' \\
          "\${STUB_REQS:-1000}" > "$dir/$out" ;;
    esac ;;
esac
exit 0`;

describe.skipIf(!bash)("cpu-abba.sh (LOAD-10)", { timeout: 120_000 }, () => {
  let box: Sandbox;
  let base: Record<string, string>;

  beforeEach(() => {
    box = sandbox();
    box.stub("docker", DOCKER);
    box.stub("sleep", "exit 0");
    box.file("state/.keep", "");
    base = {
      STUB_STATE: `${box.root}/state`,
      LOAD_ENV_FILE: box.file(
        "harness.env",
        "JWT_SECRET=x\nJWT_SECRET_REFRESH_TOKEN=y\n",
      ),
      LOAD_CONTEXT_FILE: box.file("load-context.json", "{}"),
      ABBA_A_IMAGE: "img:a",
      ABBA_B_IMAGE: "img:b",
      ABBA_LABEL: "Controle",
      ABBA_DURATION_SECONDS: "30",
      ABBA_WARMUP_SECONDS: "0",
      ABBA_IDLE_SECONDS: "0",
      ABBA_REPORT_DIR: `${box.root}/reports`,
      ABBA_WORK: `${box.root}/work`,
      BENCH_DOKPLOY_DIR: `${box.root}/no-dokploy`,
      DOCKER_HOST: "",
    };
  });

  afterEach(() => box.dispose());

  const abbaScript = (env: Record<string, string> = {}) =>
    run("bash", repoFile("tests/load/cpu-abba.sh"), [], {
      bin: box.bin,
      env: { ...base, ...env },
    });

  it("refuses a docker that points at another machine, before calling it", () => {
    const result = abbaScript({ DOCKER_HOST: "ssh://root@example.com" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("outra máquina");
    expect(box.calls("docker")).toEqual([]);
  });

  it("refuses a node of a Swarm with services, as a Dokploy server is", () => {
    const result = abbaScript({
      STUB_SWARM: "active",
      STUB_SERVICES: "abc123",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("servidor do Dokploy");
    expect(
      box.calls("docker").filter((call) => call.startsWith("docker compose")),
    ).toEqual([]);
  });

  it("refuses a node with Dokploy's folder", () => {
    box.file("no-dokploy/.keep", "");

    const result = abbaScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("nunca na VPS");
  });

  it("refuses an order that is not as many A as B, two of each", () => {
    for (const order of ["AAB", "AB", "ABXA"]) {
      const result = abbaScript({ ABBA_ORDER: order });

      expect(result.status, order).toBe(2);
    }

    expect(box.calls("docker")).toEqual([]);
  });

  it("alternates ABBAAB on fresh copies of the model and reports the control", () => {
    const result = abbaScript({ STUB_WORKER: "1" });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(lines(box, "ups")).toEqual([
      "img:a",
      "img:b",
      "img:b",
      "img:a",
      "img:a",
      "img:b",
    ]);

    const calls = box.calls("docker");
    const count = (text: string) =>
      calls.filter((call) => call.includes(text)).length;

    expect(count("CREATE DATABASE load_abba_template TEMPLATE load_test")).toBe(
      1,
    );
    expect(count("DROP DATABASE IF EXISTS load_test WITH (FORCE)")).toBe(6);
    expect(count("CREATE DATABASE load_test TEMPLATE load_abba_template")).toBe(
      6,
    );
    expect(count("redis-cli FLUSHALL")).toBe(6);
    expect(count("SELECT pg_stat_statements_reset()")).toBe(6);
    // The worker holds load_test too: stopped before each copy, started after.
    expect(count("docker start w1")).toBe(7);

    // Every run: the copy, then the replicas, then the load.
    const at = (text: string, from = 0) =>
      calls.findIndex((call, index) => index >= from && call.includes(text));
    const drop = at("WITH (FORCE)");
    const up = at(" up ", drop);
    const load = at("--summary-export /results/k6-1.json", up);

    expect(drop).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(drop);
    expect(load).toBeGreaterThan(up);
    expect(calls[load]).toContain("LOAD_DURATION=30s");
    expect(calls[load]).toContain("LOAD_RATE=60");

    // The report of the control A=B, with the cgroup's CPU per request.
    const reports = readdirSync(`${box.root}/reports`);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^\d{4}-\d{2}-\d{2}-controle\.md$/);

    const report = readFileSync(`${box.root}/reports/${reports[0]}`, "utf8");

    expect(report).toContain("| Resultado | bancada confiável |");
    expect(report).toContain("| Controle (A=B) | sim |");
    expect(report).toMatch(/\| Commit do harness \| [0-9a-f]{12}/);
    // 4 s of CPU per replica per window, two replicas, 1000 requests.
    expect(report).toContain(
      "| CPU da api por requisição | 8,00 ± 0,00 ms | 8,00 ± 0,00 ms | 0,0% |",
    );
    expect(report).toContain(
      "| Statements por requisição | 10,68 ± 0,00 | 10,68 ± 0,00 | 0,0% |",
    );
    expect(report).toContain("PROCESS_ROLE=all, cpuset 0-5");
    expect(result.stdout).toContain("A bancada mede");
  });

  it("fails a noisy control, and reuses the model a session already made", () => {
    const result = abbaScript({
      ABBA_ORDER: "ABBA",
      STUB_STEP_B: "4500000",
      STUB_TEMPLATE: "1",
    });

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("ruidosa demais");
    expect(
      box
        .calls("docker")
        .filter((call) => call.includes("CREATE DATABASE load_abba_template")),
    ).toEqual([]);
  });

  it("stops with 2 when a run's load fails", () => {
    const result = abbaScript({ STUB_K6_EXIT: "1" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("o k6 saiu com 1");
    expect(
      existsSync(`${box.root}/reports`)
        ? readdirSync(`${box.root}/reports`)
        : [],
    ).toEqual([]);
  });
});

describe.skipIf(!bash)("cpu-profile.sh (LOAD-10)", { timeout: 120_000 }, () => {
  let box: Sandbox;
  let base: Record<string, string>;

  /**
   * 100 s: the boot first, then idle, 39 s of load (handler with
   * loadSession under it a quarter of the time), idle again and the
   * shutdown in the last half second.
   */
  const PROFILE = profileOf(
    FRAMES,
    [
      ["bootStuff", 0, 5_000_000, 1000],
      ["(idle)", 5_000_000, 58_000_000, 1000],
      ["handler", 58_000_000, 97_000_000, 2000],
      ["loadSession", 58_001_000, 97_000_000, 4000],
      ["(idle)", 97_000_000, 99_500_000, 1000],
      ["shutdownStuff", 99_500_000, 100_000_000, 1000],
    ],
    100_000_000,
  );

  beforeEach(() => {
    box = sandbox();
    box.stub("docker", DOCKER);
    box.stub("sleep", "exit 0");
    box.file("state/.keep", "");
    base = {
      STUB_STATE: `${box.root}/state`,
      STUB_PROFILE: box.file("profile.cpuprofile", JSON.stringify(PROFILE)),
      LOAD_ENV_FILE: box.file(
        "harness.env",
        "JWT_SECRET=x\nJWT_SECRET_REFRESH_TOKEN=y\n",
      ),
      LOAD_CONTEXT_FILE: box.file("load-context.json", "{}"),
      PROFILE_IMAGE: "img:a",
      PROFILE_DURATION_SECONDS: "30",
      PROFILE_WARMUP_SECONDS: "0",
      PROFILE_MATCH: "loadSession",
      PROFILE_WORK: `${box.root}/work`,
      BENCH_DOKPLOY_DIR: `${box.root}/no-dokploy`,
      DOCKER_HOST: "",
    };
  });

  afterEach(() => box.dispose());

  const profileScript = (env: Record<string, string> = {}) =>
    run("bash", repoFile("tests/load/cpu-profile.sh"), [], {
      bin: box.bin,
      env: { ...base, ...env },
    });

  const flags = () =>
    readFileSync(`${box.root}/state/flags`, "utf8").split("\n").slice(0, -1);

  it("profiles the replicas under load and prints the window's top", () => {
    const result = profileScript();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(flags()[0]).toBe(
      "--cpu-prof --cpu-prof-dir=/tmp/cpu-prof --cpu-prof-interval=1000",
    );

    const calls = box.calls("docker");

    expect(calls).toContain("docker stop -t 40 api1 api2");
    expect(
      calls.filter(
        (call) =>
          call.startsWith("docker cp api1:/tmp/cpu-prof/. ") &&
          call.endsWith("/work/prof-api1"),
      ),
    ).toHaveLength(1);
    expect(result.stdout).toContain("| 1 | handler | build/server.js:10 |");
    expect(result.stdout).toContain("Sob `loadSession`: 25,0% da CPU");
    expect(result.stdout).toContain("Por requisição:");
    expect(result.stdout).not.toContain("bootStuff");
    expect(result.stdout).not.toContain("shutdownStuff");
  });

  it("puts the replicas back without the profiler, with the same image", () => {
    profileScript();

    expect(flags()[flags().length - 1]).toBe("");
    expect(lines(box, "ups")).toEqual(["img:a", "img:a"]);
  });

  it("puts them back even when the load fails", () => {
    const result = profileScript({ STUB_K6_EXIT: "1" });

    expect(result.status).toBe(2);
    expect(flags()).toEqual([
      "--cpu-prof --cpu-prof-dir=/tmp/cpu-prof --cpu-prof-interval=1000",
      "",
    ]);
  });

  it("refuses a docker that points at another machine", () => {
    const result = profileScript({
      DOCKER_HOST: "tcp://bench.example.com:2376",
    });

    expect(result.status).toBe(2);
    expect(box.calls("docker")).toEqual([]);
  });
});

function lines(box: Sandbox, name: string) {
  const path = `${box.root}/state/${name}`;

  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
}
