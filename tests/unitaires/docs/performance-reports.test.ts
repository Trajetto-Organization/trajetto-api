import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The capacity reports (docs/desempenho, plano-escala LOAD-08, section 6).
 *
 * Without a report the infrastructure step does not go up, and the
 * report is what the owner signs: a number that cannot be traced to the
 * commit, the image digests and the machine that generated the load is a
 * number nobody can reproduce or trust. So a report is versioned only with
 * the commit, the trajetto-api digest, the generator (hostname, IP and
 * nproc: the generator is always another machine), a result and every
 * criterion judged sim or não. The checker is tests/load/lib/gate-report.mjs,
 * the same file that writes the reports from tests/load/gate.sh.
 */
const ROOT = process.cwd();
const DIR = resolve(ROOT, "docs", "desempenho");
const LIB = resolve(ROOT, "tests", "load", "lib", "gate-report.mjs");

type GateReport = {
  STEPS: Record<
    string,
    {
      scenes: Array<{
        id: string;
        kind: string;
        file: string;
        criteria: Array<{ name: string }>;
      }>;
      manual: string[][];
    }
  >;
  REPORT_NAME: RegExp;
  reportProblems: (text: string, fileName?: string) => string[];
  renderReport: (work: string) => {
    markdown: string;
    result: string;
    rows: Array<{ name: string; verdict: string }>;
  };
  sceneLines: (step: string, ids?: string) => string[];
  stealOf: (text: string) => { mean: number; max: number } | null;
  digestsOf: (lines: string[]) => string[];
};

const load = () => import(pathToFileURL(LIB).href) as Promise<GateReport>;

const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const DIGEST = `sha256:${"a".repeat(64)}`;

const VMSTAT = `procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 812345  12345 456789    0    0     5    10  100  200  5  2 90  3  9
 1  0      0 812345  12345 456789    0    0     5    10  100  200  6  2 89  1  2
 1  0      0 812345  12345 456789    0    0     5    10  100  200  6  2 88  1  4
`;

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A work folder as gate.sh leaves it, for the rolling scene of gate B. */
function gateWork(
  summary: object = {
    metrics: { http_reqs: { count: 15_000, rate: 50 }, rolling_5xx: {} },
  },
) {
  const work = mkdtempSync(join(tmpdir(), "trajetto-gate-"));

  folders.push(work);
  mkdirSync(join(work, "results"));
  writeFileSync(
    join(work, "meta.env"),
    [
      "STEP=B",
      "DATE=2027-02-10",
      "GENERATOR_HOSTNAME=gerador-1",
      "GENERATOR_IP=10.0.0.9",
      "GENERATOR_NPROC=2",
      "PATH_KIND=rede privada",
      "SEED_TIER=100k",
      "REPLICAS=3",
      "HARNESS_COMMIT=0123456789abcdef0123456789abcdef01234567",
      "SCENES=rolling",
    ].join("\n"),
  );
  writeFileSync(
    join(work, "target.txt"),
    [
      "### hostname",
      "alvo-1",
      "### nproc",
      "6",
      "### memory",
      "12582912",
      "### images",
      `trajetto-api ghcr.io/trajetto-organization/trajetto-api:staging@${DIGEST}`,
      `trajetto-api-migrate ghcr.io/trajetto-organization/trajetto-api-migrate@sha256:${"b".repeat(64)}`,
    ].join("\n"),
  );
  writeFileSync(
    join(work, "liveness.json"),
    JSON.stringify({ commit: "fedcba9876543210fedcba9876543210fedcba98" }),
  );
  writeFileSync(join(work, "vmstat.log"), VMSTAT);
  writeFileSync(
    join(work, "stats.log"),
    "=== rolling\ntrajetto-api.1.abc 42.50% 310MiB / 1GiB\n",
  );
  writeFileSync(join(work, "pgss.txt"), "1234.5 | 9000 | 0.14 | SELECT 1\n");
  writeFileSync(join(work, "results", "rolling.json"), JSON.stringify(summary));
  writeFileSync(join(work, "results", "rolling.exit"), "0\n");

  return work;
}

/** A generated report with every pending row filled, as the owner would. */
const filled = (markdown: string) =>
  markdown
    .replace("| Resultado | incompleto |", "| Resultado | aprovado |")
    .replace(/\| pendente \|$/gm, "| sim |");

describe("the reports in docs/desempenho (LOAD-08)", () => {
  const reports = existsSync(DIR)
    ? readdirSync(DIR).filter(
        (name) =>
          name.endsWith(".md") && !["README.md", "TEMPLATE.md"].includes(name),
      )
    : [];

  it("are only reports, each named <date>-<gate>.md", async () => {
    const { REPORT_NAME } = await load();

    expect(reports.filter((name) => !REPORT_NAME.test(name))).toEqual([]);
  });

  it("carry the commit, the digests, the generator and every criterion judged", async () => {
    const { reportProblems } = await load();
    const problems = reports.flatMap((name) =>
      reportProblems(read(join(DIR, name)), name).map(
        (problem) => `${name}: ${problem}`,
      ),
    );

    expect(problems).toEqual([]);
  });

  it("are each in the README's table", () => {
    const readme = read(join(DIR, "README.md"));

    for (const name of reports) expect(readme, name).toContain(`(./${name})`);
  });
});

describe("the checker (LOAD-08)", () => {
  it("accepts a generated report once its pending rows are filled", async () => {
    const { renderReport, reportProblems } = await load();
    const { markdown, result } = renderReport(gateWork());

    expect(result).toBe("incompleto");
    expect(reportProblems(filled(markdown), "2027-02-10-B.md")).toEqual([]);
  });

  it("refuses a report still pending, as the gate writes it", async () => {
    const { renderReport, reportProblems } = await load();
    const problems = reportProblems(renderReport(gateWork()).markdown);

    expect(problems).toContain(
      "resultado 'incompleto': precisa ser aprovado, reprovado ou no limite",
    );
    expect(problems.some((problem) => /está 'pendente'/.test(problem))).toBe(
      true,
    );
  });

  it.each([
    [
      "without the commit",
      (text: string) =>
        text.replace(/^\| Commit \|.*$/m, "| Commit | não medido |"),
      "sem o commit (um sha) em 'O que rodou'",
    ],
    [
      "without the digest",
      (text: string) =>
        text.replace(/^\| Digests \|.*$/m, "| Digests | não medido |"),
      "sem o digest da imagem trajetto-api em 'O que rodou'",
    ],
    [
      "with only the migrate image's digest",
      (text: string) =>
        text.replace(
          /^\| Digests \|.*$/m,
          `| Digests | \`trajetto-api-migrate@${DIGEST}\` |`,
        ),
      "sem o digest da imagem trajetto-api em 'O que rodou'",
    ],
    [
      "without the generator's hostname",
      (text: string) =>
        text.replace("| Hostname | gerador-1 |", "| Hostname |  |"),
      "sem o hostname do gerador",
    ],
    [
      "without the generator's IP",
      (text: string) => text.replace("| IP | 10.0.0.9 |", "| IP | o meu |"),
      "sem o IP do gerador",
    ],
    [
      "without the generator's nproc",
      (text: string) => text.replace("| `nproc` | 2 |", "| `nproc` |  |"),
      "sem o nproc do gerador",
    ],
    [
      "with a template field left",
      (text: string) => `${text}\nCommit da web: \`<sha>\`\n`,
      "há campo do template ainda sem valor (`<…>`)",
    ],
  ])("refuses a report %s", async (_, change, problem) => {
    const { renderReport, reportProblems } = await load();
    const text = change(filled(renderReport(gateWork()).markdown));

    expect(reportProblems(text)).toContain(problem);
  });

  it("reads the generator's fields in its own section, not the target's", async () => {
    const { renderReport, reportProblems } = await load();
    const text = filled(renderReport(gateWork()).markdown).replace(
      /\n## O gerador\n[\s\S]*?\n## /,
      "\n## ",
    );

    expect(reportProblems(text)).toEqual(
      expect.arrayContaining([
        "sem o hostname do gerador",
        "sem o IP do gerador",
        "sem o nproc do gerador",
      ]),
    );
  });

  it("refuses a file name that is not <date>-<gate>.md", async () => {
    const { renderReport, reportProblems } = await load();
    const text = filled(renderReport(gateWork()).markdown);

    expect(reportProblems(text, "carga-2026-10.md")).toEqual([
      "o nome não é <data>-<degrau>.md (B, 100k, 1m ou 5m): carga-2026-10.md",
    ]);
    expect(reportProblems(text, "2027-02-10-100k-2.md")).toEqual([]);
  });

  it("is what TEMPLATE.md is filled into", () => {
    const template = read(join(DIR, "TEMPLATE.md"));

    for (const heading of [
      "## Resumo",
      "## O que rodou",
      "## A máquina do alvo",
      "## O gerador",
      "## Critérios e números",
    ]) {
      expect(template, heading).toContain(`\n${heading}\n`);
    }

    for (const row of ["Resultado", "Commit", "Digests", "Hostname", "IP"]) {
      expect(template, row).toMatch(new RegExp(`\\n\\| ${row} +\\|`));
    }

    expect(template).toMatch(/\n\| `nproc` +\|/);
    expect(template).toContain("gate.sh");
  });
});

describe("the report the gate writes (LOAD-08)", () => {
  it("judges each criterion from the scene's summary", async () => {
    const { renderReport } = await load();
    const { rows } = renderReport(gateWork());

    expect(rows.find((row) => row.name === "respostas 5xx (rolling)")).toEqual(
      expect.objectContaining({ verdict: "sim" }),
    );
    expect(rows.find((row) => row.name === "steal registrado")).toEqual(
      expect.objectContaining({ verdict: "sim" }),
    );
    // gate B's load did not run (GATE_SCENES=rolling): pending, never sim.
    expect(
      rows.find((row) => row.name === "vazão por réplica (load)")?.verdict,
    ).toBe("pendente");
  });

  it("fails the gate on a 5xx, and on a scene that wrote no summary", async () => {
    const { renderReport } = await load();

    expect(
      renderReport(
        gateWork({
          metrics: {
            http_reqs: { count: 15_000, rate: 50 },
            rolling_5xx: { count: 3 },
          },
        }),
      ).result,
    ).toBe("reprovado");

    const dir = gateWork();

    rmSync(join(dir, "results", "rolling.json"));
    writeFileSync(join(dir, "results", "rolling.exit"), "107\n");

    const { rows, result } = renderReport(dir);

    expect(result).toBe("reprovado");
    expect(
      rows.find((row) => row.name === "respostas 5xx (rolling)"),
    ).toMatchObject({
      verdict: "não",
      measured: "a cena não gravou o resumo (saída 107)",
    });
  });

  it("keeps the API's digest with its tag, without the registry", async () => {
    const { digestsOf } = await load();

    expect(
      digestsOf([
        `api ghcr.io/trajetto-organization/trajetto-api:staging@${DIGEST}`,
        `web ghcr.io/trajetto-organization/trajetto-ui@${DIGEST}`,
      ]),
    ).toEqual([`trajetto-api:staging@${DIGEST}`, `trajetto-ui@${DIGEST}`]);
  });

  it("reads the steal without the since-boot line", async () => {
    const { stealOf } = await load();

    expect(stealOf(VMSTAT)).toEqual({ mean: 3, max: 4, samples: 2 });
    expect(stealOf("")).toBeNull();
  });

  // k6 exports a tagged submetric only when a threshold names it, and the
  // p99 only when summaryTrendStats asks for it: without these, the 100k
  // gate's p99 and soak rows would read "sem amostras" and fail a good run.
  it("reads only what the scenes export", () => {
    const scene = (name: string) => read(resolve(ROOT, "tests", "load", name));

    expect(scene("load.js")).toContain(
      "summaryTrendStats: SUMMARY_TREND_STATS",
    );
    expect(scene("soak.js")).toContain('"surface_latency{phase:early}"');
    expect(scene("soak.js")).toContain('"surface_latency{phase:late}"');
  });

  it("runs only scenes the harness has", async () => {
    const { STEPS, sceneLines } = await load();

    for (const [step, gate] of Object.entries(STEPS)) {
      for (const scene of gate.scenes) {
        expect(
          existsSync(resolve(ROOT, "tests", "load", scene.file)),
          `${step}/${scene.file}`,
        ).toBe(true);
        expect(["k6", "fleet"]).toContain(scene.kind);
      }

      expect(sceneLines(step)).toHaveLength(gate.scenes.length);
    }

    expect(sceneLines("B", "rolling")).toEqual([
      "rolling k6 rolling.js 300 1 ROLLING_RATE=50 ROLLING_DURATION=5m",
    ]);
    expect(() => sceneLines("B", "tower")).toThrow(/Cena desconhecida/);
    expect(() => sceneLines("2m")).toThrow(/Portão desconhecido/);
  });
});
