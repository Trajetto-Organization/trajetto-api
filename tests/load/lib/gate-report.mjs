import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  countOf,
  metricOf,
  noisyTenantVerdict,
  outageVerdict,
  rateOf,
  spikeVerdict,
  statOf,
} from "./verdicts.mjs";

/**
 * The capacity gates' report (plano-escala LOAD-08, section 6).
 *
 * One place says what each gate runs and how each criterion reads the
 * scenes' summaries: tests/load/gate.sh asks it for the scenes of a gate
 * (`scenes`), runs them, collects the machines' facts into a work folder,
 * and this file writes docs/desempenho/<date>-<gate>.md from them
 * (`render`), one row per criterion with its limit, what was measured and
 * whether it passed. A criterion no scene of the harness measures yet (the
 * queue drains of LOAD-04, the scale-out of 3 to 6, PITR...) comes out
 * "pendente", with how to measure it: the owner fills it before the report
 * is versioned, and `check` (the docs test, performance-reports) refuses a
 * report with a row still pending, without the commit, without the image
 * digests or without the generator (hostname, IP and nproc): a number
 * without them cannot be traced to the code, the image or the machine that
 * produced it.
 *
 *   node tests/load/lib/gate-report.mjs scenes <B|100k|1m|5m> [ids]
 *   node tests/load/lib/gate-report.mjs render <work folder> <report.md>
 *   node tests/load/lib/gate-report.mjs check <report.md>...
 */

const STEPS_NAMES = ["B", "100k", "1m", "5m"];

/** The file name of a report: `<date>-<gate>.md`, or `-2`… for a redo. */
const REPORT_NAME = /^\d{4}-\d{2}-\d{2}-(B|100k|1m|5m)(-\d+)?\.md$/;

const RESULTS = ["aprovado", "reprovado", "no limite"];

// ------------------------------------------------------------ the criteria

const ms = (value) =>
  value === null ? "sem amostras" : `${Math.round(value)} ms`;

const percent = (value) =>
  value === null ? "sem amostras" : `${(value * 100).toFixed(2)}%`;

const p95Below = (limitMs) => ({
  name: "p95",
  limit: `< ${limitMs} ms`,
  judge(summary) {
    const value = statOf(summary, "surface_latency", "p(95)");

    return { measured: ms(value), pass: value !== null && value < limitMs };
  },
});

const p99Below = (limitMs) => ({
  name: "p99",
  limit: `< ${limitMs} ms`,
  judge(summary) {
    const value = statOf(summary, "surface_latency", "p(99)");

    return { measured: ms(value), pass: value !== null && value < limitMs };
  },
});

const failuresAtMost = (share) => ({
  name: "falhas de produto",
  limit: share === 0 ? "0" : `< ${share * 100}%`,
  judge(summary) {
    const value = rateOf(summary, "surface_failures");

    return {
      measured: percent(value),
      pass: value !== null && (share === 0 ? value === 0 : value < share),
    };
  },
});

const throttledBelow = (share) => ({
  name: "recusas com Retry-After",
  limit: `< ${share * 100}%`,
  judge(summary) {
    const value = rateOf(summary, "surface_throttled") ?? 0;

    return { measured: percent(value), pass: value < share };
  },
});

const perReplicaAtLeast = (rps) => ({
  name: "vazão por réplica",
  limit: `≥ ${rps} req/s`,
  judge(summary, context) {
    const rate = metricOf(summary, "http_reqs")?.rate;
    const value = typeof rate === "number" ? rate / context.replicas : null;

    return {
      measured:
        value === null
          ? "sem amostras"
          : `${value.toFixed(1)} req/s (${context.replicas} réplicas)`,
      pass: value !== null && value >= rps,
    };
  },
});

const no5xx = {
  name: "respostas 5xx",
  limit: "0",
  judge(summary) {
    const requests = metricOf(summary, "http_reqs")?.count ?? 0;
    const errors = countOf(summary, "rolling_5xx");

    return {
      measured: requests > 0 ? `${errors}` : "nenhuma requisição",
      pass: requests > 0 && errors === 0,
    };
  },
};

const soakDrift = {
  name: "p95 do fim sobre o do começo",
  limit: "≤ 1,2×",
  judge(summary) {
    const early = statOf(summary, "surface_latency{phase:early}", "p(95)");
    const late = statOf(summary, "surface_latency{phase:late}", "p(95)");
    const ratio = early && late !== null ? late / early : null;

    return {
      measured:
        ratio === null
          ? "sem amostras de uma das fases"
          : `${ratio.toFixed(2)}× (${ms(early)} → ${ms(late)})`,
      pass: ratio !== null && ratio <= 1.2,
    };
  },
};

/** One of lib/verdicts.mjs, as a row. */
const verdictOf = (name, limit, judge) => ({
  name,
  limit,
  judge(summary, context) {
    const verdict = judge(summary, context);

    return {
      measured: verdict.pass ? "aprovado" : verdict.reasons.join("; "),
      pass: verdict.pass,
    };
  },
});

const spikeAcceptance = verdictOf(
  "o pico com o descarte",
  "0 falhas, p95 < 1 s, volta abaixo de 1 s",
  (summary) => spikeVerdict(summary),
);

const noisyAcceptance = verdictOf(
  "os normais ao lado do barulhento",
  "p95 ±10%, 0 falhas, 429 para o barulhento",
  (summary, context) =>
    noisyTenantVerdict(summary, { expectThrottle: context.expectThrottle }),
);

const outageAcceptance = verdictOf(
  "a volta depois de 2 min de queda",
  "POST/s ≤ 1,2× durante e ≤ 1,5× depois",
  (summary) => outageVerdict(summary),
);

/** socket-fleet.mjs's own verdict, one row. */
const fleetAcceptance = (sockets) => ({
  name: `${sockets.toLocaleString("pt-BR")} sockets`,
  limit: "todos conectados, 0 quedas, 99% de volta em ≤ 60 s",
  judge(summary) {
    if (summary?.scene !== "socket-fleet") {
      return { measured: "sem o resumo da frota", pass: false };
    }

    const failed = summary.verdict.criteria
      .filter((criterion) => !criterion.pass)
      .map((criterion) => `${criterion.name}: ${criterion.measured}`);

    return {
      measured:
        `${summary.sockets.connected}/${summary.sockets.planned} conectados, ` +
        `${summary.drops.unexpected} quedas, handshake p95 ${ms(summary.handshakes.p95Ms)}` +
        (failed.length ? `; ${failed.join("; ")}` : ""),
      pass: summary.verdict.pass,
    };
  },
});

// ------------------------------------------------------------ the gates

/**
 * What each gate runs (plano-escala section 6). `seconds` is the scene's
 * planned length: gate.sh takes the docker stats of the target at its
 * middle. `env` goes to the scene as is; gate.sh adds the target and the
 * fixture. The rows a scene of the harness cannot measure are `manual`.
 */
const STEPS = {
  B: {
    title: "Portão B: burn-in do servidor novo, vazio",
    seed: "100k",
    scenes: [
      {
        id: "load",
        kind: "k6",
        file: "load.js",
        env: { LOAD_RATE: "240", LOAD_DURATION: "30m" },
        seconds: 1_800,
        criteria: [perReplicaAtLeast(80), failuresAtMost(0.01)],
      },
      {
        id: "rolling",
        kind: "k6",
        file: "rolling.js",
        env: { ROLLING_RATE: "50", ROLLING_DURATION: "5m" },
        seconds: 300,
        redeploy: true,
        criteria: [no5xx],
      },
    ],
    manual: [
      [
        "load.js com 1 e 2 réplicas",
        "≥ 80 req/s por réplica",
        "o gate.sh B com GATE_REPLICAS=1 e =2 e GATE_SCENES=load",
      ],
      [
        "escala de 3 para 6 réplicas",
        "max/média de req/s por réplica ≤ 1,3 em 5 min",
        "swarm-rolling.sh no alvo, ou o access log do Traefik",
      ],
      [
        "a saída do VIP antes do SIGTERM",
        "no log do Traefik, durante o rolling",
        "o log do Traefik do alvo na hora do Redeploy",
      ],
      [
        "dynamic_shared_memory_type=sysv com consulta paralela",
        "sem erro de memória compartilhada",
        "uma consulta paralela no psql do alvo",
      ],
    ],
  },
  "100k": {
    title: "Portão do 100k, no servidor vazio",
    seed: "100k",
    scenes: [
      {
        id: "load",
        kind: "k6",
        file: "load.js",
        env: { LOAD_RATE: "200", LOAD_DURATION: "30m" },
        seconds: 1_800,
        criteria: [
          failuresAtMost(0),
          p95Below(250),
          p99Below(1_000),
          throttledBelow(0.02),
        ],
      },
      {
        id: "soak",
        kind: "k6",
        file: "soak.js",
        env: { SOAK_RATE: "60", SOAK_DURATION: "2h" },
        seconds: 7_200,
        criteria: [soakDrift],
      },
      {
        id: "spike",
        kind: "k6",
        file: "spike.js",
        env: { SPIKE_ACCEPTANCE: "true" },
        seconds: 600,
        criteria: [spikeAcceptance],
      },
      {
        id: "sockets",
        kind: "fleet",
        file: "socket-fleet.mjs",
        env: { FLEET_SOCKETS: "1000", FLEET_DURATION: "65m" },
        seconds: 3_900,
        criteria: [fleetAcceptance(1_000)],
      },
      {
        id: "rolling",
        kind: "k6",
        file: "rolling.js",
        env: { ROLLING_RATE: "100", ROLLING_DURATION: "5m" },
        seconds: 300,
        redeploy: true,
        criteria: [no5xx],
      },
      {
        id: "noisy-tenant",
        kind: "k6",
        file: "noisy-tenant.js",
        env: {},
        seconds: 360,
        criteria: [noisyAcceptance],
      },
      {
        id: "outage",
        kind: "k6",
        file: "outage.js",
        env: { OUTAGE_CONTRACT: "mixed", OUTAGE_CONTRACT8_SHARE: "0.9" },
        seconds: 420,
        criteria: [outageAcceptance],
      },
    ],
    manual: [
      [
        "evento entre réplicas",
        "p95 < 2 s",
        "socket-across-replicas.mjs contra o alvo, repetido",
      ],
      [
        "dreno de 50 mil + 20 mil",
        "< 15 min, com o HTTP em p95 < 300 ms",
        "a cena drain-backlog do LOAD-04",
      ],
      [
        "queue-flood",
        "p95 external dos outros < 60 s",
        "a cena queue-flood do LOAD-04",
      ],
      [
        "import-20k",
        "lag p99 da api < 100 ms, RSS no orçamento, coordenadas em < 2 h",
        "as cenas import-20k e import-geocode do LOAD-04",
      ],
      [
        "PITR",
        "RTO < 1 h e perda ≤ 2 min",
        "o ensaio mensal da produção (docs/runbooks/drills.md)",
      ],
    ],
  },
  "1m": {
    title: "Portão do 1M, no hardware-alvo",
    seed: "1m",
    scenes: [
      {
        id: "load",
        kind: "k6",
        file: "load.js",
        env: { LOAD_RATE: "1200", LOAD_DURATION: "60m" },
        seconds: 3_600,
        criteria: [p95Below(300), failuresAtMost(0)],
      },
      {
        id: "sockets",
        kind: "fleet",
        file: "socket-fleet.mjs",
        env: { FLEET_SOCKETS: "5000", FLEET_DURATION: "40m" },
        seconds: 2_400,
        criteria: [fleetAcceptance(5_000)],
      },
    ],
    manual: [
      [
        "ELU, CPU do Postgres, pool e PgBouncer no load",
        "ELU p95 ≤ 0,7, CPU < 60%, waiting = 0, servidor < 70%",
        "o ops_sample e o SHOW POOLS da corrida",
      ],
      [
        "posições a 150 POST/s × 4 pontos",
        "sem 5xx",
        "positions.js com a frota do degrau",
      ],
      [
        "RSS com 5.000 sockets",
        "< 75% do limite",
        "o docker stats da cena sockets, abaixo",
      ],
      ["dreno de 50 mil + 20 mil", "< 15 min", "a cena do LOAD-04"],
      [
        "Torre sem eventos",
        "≤ réplicas × 6 cálculos por empresa por minuto",
        "tower.js e o ops_sample",
      ],
      [
        "visão geral com 3 M de entregas",
        "p95 < 100 ms, com o rollup",
        "a leitura do painel no degrau",
      ],
      [
        "rolling do PgBouncer",
        "0 respostas 5xx",
        "rolling.js durante o Redeploy do PgBouncer",
      ],
      [
        "promote com retarget",
        "RTO < 15 min, RPO < 10 s, época subindo, feed sem pulo",
        "o ensaio de failover",
      ],
      ["PITR em tamanho real", "RTO < 4 h", "o ensaio de restauração"],
      ["CPU por requisição", "≤ 6 ms no ABBA", "a bancada do LOAD-10"],
      [
        "15 min pela Cloudflare",
        "sem 5xx",
        "load.js pela borda, no fim do portão",
      ],
    ],
  },
  "5m": {
    title: "Portão do 5M, no hardware-alvo da F5",
    seed: "5m",
    scenes: [
      {
        id: "load",
        kind: "k6",
        file: "load.js",
        env: { LOAD_RATE: "3000", LOAD_DURATION: "60m" },
        seconds: 3_600,
        criteria: [p95Below(300), failuresAtMost(0)],
      },
    ],
    manual: [
      [
        "500 POST/s de posições (2.000 pontos/s)",
        "p95 < 150 ms, e o ABBA do group commit e do cache",
        "positions-5m.js com POSITIONS_5M_ACCEPTANCE=true e o ABBA de positions-abba.sh (LOAD-11; no alvo, à mão)",
      ],
      [
        "24 mil sockets por 2 h, matando um realtime",
        "de volta em ≤ 60 s, < 1% de 429",
        "socket-fleet em vários geradores (FLEET_SHARD) e o merge",
      ],
      [
        "rolling completo a 50% da carga",
        "0 respostas 5xx",
        "rolling.js durante o Redeploy",
      ],
      [
        "cl_waiting e a réplica",
        "cl_waiting ≈ 0, lag p99 < 5 s",
        "SHOW POOLS e pg_stat_replication",
      ],
      [
        "folga de 10×",
        "3.330 POST/s por 10 min, 0 ponto perdido",
        "positions-5m.js com POSITIONS_5M_RATE=3330, contando a janela no banco (LOAD-11)",
      ],
      [
        "DROP de um dia de fila",
        "< 1 min sob carga",
        "queue-drop-under-load.mjs com o load.js ao lado e o veredito queue-drop (LOAD-11)",
      ],
      ["outbox oldest_pending", "p95 < 30 s", "o ops_sample da corrida"],
      [
        "15 min pela Cloudflare",
        "sem 5xx",
        "load.js pela borda, no fim do portão",
      ],
    ],
  },
};

/**
 * The scenes of a gate, one line each, for gate.sh:
 * `<id> <kind> <file> <seconds> <redeploy 0|1> [KEY=VALUE...]`.
 * `ids` (GATE_SCENES) keeps only those.
 */
function sceneLines(step, ids = "") {
  const gate = STEPS[step];

  if (!gate) {
    throw new Error(`Portão desconhecido: '${step}' (B, 100k, 1m ou 5m).`);
  }

  const wanted = ids.split(/[\s,]+/).filter(Boolean);
  const unknown = wanted.filter(
    (id) => !gate.scenes.some((scene) => scene.id === id),
  );

  if (unknown.length > 0) {
    throw new Error(
      `Cena desconhecida no portão ${step}: ${unknown.join(", ")} (há ${gate.scenes.map((scene) => scene.id).join(", ")}).`,
    );
  }

  return gate.scenes
    .filter((scene) => wanted.length === 0 || wanted.includes(scene.id))
    .map((scene) =>
      [
        scene.id,
        scene.kind,
        scene.file,
        scene.seconds,
        scene.redeploy ? 1 : 0,
        ...Object.entries(scene.env).map(([key, value]) => `${key}=${value}`),
      ].join(" "),
    );
}

// ------------------------------------------------------------ the facts

/** KEY=VALUE lines; the value is the rest of the line. */
function readMeta(text) {
  const meta = {};

  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");

    if (at > 0) meta[line.slice(0, at)] = line.slice(at + 1);
  }

  return meta;
}

/** The `### <name>` sections of what the target answered over SSH. */
function sectionsOf(text) {
  const sections = {};
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const header = /^### (\S+)/.exec(line);

    if (header) {
      current = header[1];
      sections[current] = [];
      continue;
    }

    if (current && line.trim()) sections[current].push(line.trim());
  }

  return sections;
}

/** Mean and maximum of vmstat's `st` column, the since-boot line skipped. */
function stealOf(text) {
  let st = -1;
  let rows = 0;
  const values = [];

  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);

    if (fields.includes("st")) {
      st = fields.indexOf("st");
      continue;
    }

    if (st >= 0 && /^\d+$/.test(fields[0] ?? "")) {
      rows += 1;

      if (rows > 1) values.push(Number(fields[st]));
    }
  }

  if (values.length === 0) return null;

  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
    samples: values.length,
  };
}

/** The image digests the target runs: `name@sha256:<64 hex>`, once each. */
function digestsOf(lines) {
  const found = new Set();

  for (const line of lines) {
    // The tag stays when the image has one (`trajetto-api:staging@sha256:…`,
    // as the Swarm writes a service's image); the registry path goes.
    for (const match of line.matchAll(/([\w./:-]+@sha256:[0-9a-f]{64})/g)) {
      found.add(match[1].replace(/^.*\//, ""));
    }
  }

  return [...found].sort();
}

/** The busiest snapshot of each container: `name → { cpu, memory }`. */
function peaksOf(text) {
  const peaks = new Map();
  let scene = null;

  for (const line of text.split(/\r?\n/)) {
    const header = /^=== (\S+)/.exec(line);

    if (header) {
      scene = header[1];
      continue;
    }

    const [name, cpu, ...rest] = line.trim().split(/\s+/);
    const value = Number.parseFloat(cpu ?? "");

    if (!name || !Number.isFinite(value)) continue;

    const previous = peaks.get(name);

    if (!previous || value > previous.cpuValue) {
      peaks.set(name, {
        cpu: cpu,
        cpuValue: value,
        memory: rest.join(" "),
        scene,
      });
    }
  }

  return peaks;
}

const readIf = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ the report

/** The rows of the criteria table: every scene's, the machine's, the manual. */
function judgeGate(step, work, context) {
  const gate = STEPS[step];
  const ran = (context.scenes ?? gate.scenes.map((scene) => scene.id))
    .toString()
    .split(/[\s,]+/)
    .filter(Boolean);
  const rows = [];

  for (const scene of gate.scenes) {
    if (!ran.includes(scene.id)) {
      for (const criterion of scene.criteria) {
        rows.push({
          name: `${criterion.name} (${scene.id})`,
          limit: criterion.limit,
          measured: "a medir: a cena não rodou nesta corrida (GATE_SCENES)",
          verdict: "pendente",
        });
      }
      continue;
    }

    const summary = readJson(resolve(work, "results", `${scene.id}.json`));
    const exit = readIf(resolve(work, "results", `${scene.id}.exit`)).trim();

    for (const criterion of scene.criteria) {
      if (!summary) {
        rows.push({
          name: `${criterion.name} (${scene.id})`,
          limit: criterion.limit,
          measured: `a cena não gravou o resumo (saída ${exit || "?"})`,
          verdict: "não",
        });
        continue;
      }

      const { measured, pass } = criterion.judge(summary, context);

      rows.push({
        name: `${criterion.name} (${scene.id})`,
        limit: criterion.limit,
        measured,
        verdict: pass ? "sim" : "não",
      });
    }
  }

  const steal = stealOf(readIf(resolve(work, "vmstat.log")));

  rows.push({
    name: "steal registrado",
    limit: "medido durante a corrida",
    measured: steal
      ? `média ${steal.mean.toFixed(1)}%, máximo ${steal.max}% (${steal.samples} amostras)`
      : "sem amostras do vmstat do alvo",
    verdict: steal ? "sim" : "não",
  });

  for (const [name, limit, how] of gate.manual) {
    rows.push({
      name,
      limit,
      measured: `a medir: ${how}`,
      verdict: "pendente",
    });
  }

  return rows;
}

/** aprovado, reprovado or incompleto (rows still pending). */
function resultOf(rows) {
  if (rows.some((row) => row.verdict === "não")) return "reprovado";
  if (rows.some((row) => row.verdict === "pendente")) return "incompleto";

  return "aprovado";
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(header, rows) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** The report's Markdown, in the shape of docs/desempenho/TEMPLATE.md. */
function renderReport(work) {
  const meta = readMeta(readIf(resolve(work, "meta.env")));
  const step = meta.STEP;
  const gate = STEPS[step];

  if (!gate) throw new Error(`meta.env sem um portão conhecido: '${step}'.`);

  const target = sectionsOf(readIf(resolve(work, "target.txt")));
  const liveness = readJson(resolve(work, "liveness.json")) ?? {};
  const context = {
    replicas: Number(meta.REPLICAS || 3),
    expectThrottle: meta.EXPECT_THROTTLE === "true",
    scenes: meta.SCENES || gate.scenes.map((scene) => scene.id).join(" "),
  };
  const rows = judgeGate(step, work, context);
  const result = resultOf(rows);
  const digests = digestsOf(target.images ?? []);
  const steal = stealOf(readIf(resolve(work, "vmstat.log")));
  const memoryKb = Number(target.memory?.[0]);
  const peaks = peaksOf(readIf(resolve(work, "stats.log")));
  const pgss = readIf(resolve(work, "pgss.txt")).trim();
  const apiCommit = liveness.commit
    ? `\`${liveness.commit}\` (API, \`/health/liveness\` do alvo${liveness.version ? `, versão ${liveness.version}` : ""})`
    : "não medido: o alvo não respondeu o `/health/liveness`";

  const lines = [
    `# Portão \`${step}\` — \`${meta.DATE}\``,
    "",
    `> Escrito pelo \`tests/load/gate.sh ${step}\` (${gate.title}). As linhas`,
    "> pendentes são preenchidas pelo dono, com o medido e sim ou não, e o",
    "> resultado passa a aprovado, reprovado ou no limite antes de o relatório",
    "> entrar no repositório (`performance-reports.test.ts`).",
    "",
    "## Resumo",
    "",
    table(
      ["Campo", "Valor"],
      [
        ["Degrau", meta.SEED_TIER || gate.seed],
        ["Portão", step],
        ["Resultado", result],
        [
          "`APPROVED_GATE_MONTHLY_DELIVERIES` proposto",
          "a decidir pelo dono, com o relatório aprovado",
        ],
        ["Aprovado por", "pendente (o dono)"],
      ],
    ),
    "",
    "## O que rodou",
    "",
    table(
      ["Campo", "Valor"],
      [
        [
          "Commit",
          `${apiCommit}; \`${meta.HARNESS_COMMIT || "?"}\` (harness, no gerador)`,
        ],
        [
          "Digests",
          digests.length
            ? digests.map((digest) => `\`${digest}\``).join(", ")
            : "não medido: o alvo não listou imagens por digest",
        ],
        ["Seed", `\`LOAD_TIER=${meta.SEED_TIER || gate.seed}\``],
        ["Réplicas", `${context.replicas} da api (\`GATE_REPLICAS\`)`],
        ["Variáveis", meta.VARIABLES || "as do padrão"],
        ["Cenas", context.scenes],
      ],
    ),
    "",
    "## A máquina do alvo",
    "",
    table(
      ["Campo", "Valor"],
      [
        [
          "Máquina",
          meta.TARGET_MACHINE || "não informada (`GATE_TARGET_MACHINE`)",
        ],
        ["`nproc`", target.nproc?.[0] ?? "não medido"],
        [
          "Memória e disco",
          Number.isFinite(memoryKb)
            ? `${(memoryKb / 1_048_576).toFixed(1)} GiB`
            : "não medido",
        ],
        [
          "Steal",
          steal
            ? `média ${steal.mean.toFixed(1)}%, máximo ${steal.max}% (\`vmstat 5\`)`
            : "não medido",
        ],
        ["Hostname", target.hostname?.[0] ?? "não medido"],
      ],
    ),
    "",
    "## O gerador",
    "",
    table(
      ["Campo", "Valor"],
      [
        ["Hostname", meta.GENERATOR_HOSTNAME || ""],
        ["IP", meta.GENERATOR_IP || ""],
        ["`nproc`", meta.GENERATOR_NPROC || ""],
        ["Caminho", meta.PATH_KIND || "rede privada"],
      ],
    ),
    "",
    "## Critérios e números",
    "",
    table(
      ["Critério", "Limite", "Medido", "Passou"],
      rows.map((row) => [row.name, row.limit, row.measured, row.verdict]),
    ),
    "",
    "## Anexos",
    "",
    `Os resumos de cada cena (o \`--summary-export\` do k6 e o JSON do \`socket-fleet\`) ficaram no gerador, em \`${meta.WORK_LABEL || "tests/load/results"}\`.`,
    "",
    "**`docker stats` do alvo** (o pico de CPU de cada contêiner, no meio de cada cena):",
    "",
    peaks.size
      ? table(
          ["Contêiner", "CPU", "Memória", "Cena"],
          [...peaks.entries()].map(([name, peak]) => [
            name,
            peak.cpu,
            peak.memory,
            peak.scene ?? "",
          ]),
        )
      : "não medido.",
    "",
    "**Top 20 do `pg_stat_statements`** da corrida, por tempo total (ms total | chamadas | ms por chamada | consulta):",
    "",
    pgss ? ["```text", pgss, "```"].join("\n") : "não medido.",
    "",
    "## O que mudou por causa disto",
    "",
    "A preencher pelo dono: o que a corrida achou, o que foi corrigido (com o commit e o teste que guarda) e o que ficou para o próximo portão.",
    "",
  ];

  return { markdown: lines.join("\n"), result, rows };
}

// ------------------------------------------------------------ the check

/** The value of a `| Campo | Valor |` row, inside `section` when given. */
function fieldOf(text, label, section) {
  let scope = text;

  if (section) {
    const start = text.indexOf(`\n## ${section}`);

    if (start < 0) return null;

    const end = text.indexOf("\n## ", start + 4);

    scope = text.slice(start, end < 0 ? undefined : end);
  }

  for (const line of scope.split(/\r?\n/)) {
    const cells = line.split("|").map((part) => part.trim());

    if (cells.length >= 4 && cells[1] === label) return cells[2];
  }

  return null;
}

/** The rows of the criteria table: `[criterion, limit, measured, passed]`. */
function criteriaRows(text) {
  const start = text.indexOf("\n## Critérios e números");

  if (start < 0) return null;

  const end = text.indexOf("\n## ", start + 4);
  const scope = text.slice(start, end < 0 ? undefined : end);

  return scope
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((part) => part.trim()),
    );
}

/**
 * Why a report may not be versioned; empty when it may. The rule of
 * docs/desempenho/README.md: the commit, the digests and the generator
 * (hostname, IP and nproc), a result, and every criterion judged.
 */
function reportProblems(text, fileName = null) {
  const problems = [];

  if (fileName && !REPORT_NAME.test(basename(fileName))) {
    problems.push(
      `o nome não é <data>-<degrau>.md (B, 100k, 1m ou 5m): ${basename(fileName)}`,
    );
  }

  if (!/^# Portão /m.test(text)) problems.push("sem o título '# Portão'");

  const result = fieldOf(text, "Resultado", "Resumo");

  if (!RESULTS.includes(result ?? "")) {
    problems.push(
      `resultado '${result ?? "ausente"}': precisa ser aprovado, reprovado ou no limite`,
    );
  }

  if (
    !/\b[0-9a-f]{7,40}\b/.test(fieldOf(text, "Commit", "O que rodou") ?? "")
  ) {
    problems.push("sem o commit (um sha) em 'O que rodou'");
  }

  if (
    !/(^|[\s`])trajetto-api(:[\w.-]+)?@sha256:[0-9a-f]{64}/.test(
      fieldOf(text, "Digests", "O que rodou") ?? "",
    )
  ) {
    problems.push("sem o digest da imagem trajetto-api em 'O que rodou'");
  }

  const hostname = fieldOf(text, "Hostname", "O gerador") ?? "";
  const address = (fieldOf(text, "IP", "O gerador") ?? "")
    .replace(/`/g, "")
    .trim();
  const nproc = (fieldOf(text, "`nproc`", "O gerador") ?? "")
    .replace(/`/g, "")
    .trim();

  if (!hostname || /[<>]/.test(hostname)) {
    problems.push("sem o hostname do gerador");
  }

  if (!isIP(address)) problems.push("sem o IP do gerador");

  if (!/^[1-9]\d*$/.test(nproc)) problems.push("sem o nproc do gerador");

  const rows = criteriaRows(text);

  if (!rows || rows.length === 0) {
    problems.push("sem a tabela 'Critérios e números'");
  } else {
    for (const [name, , , passed] of rows) {
      if (!["sim", "não"].includes(passed)) {
        problems.push(`o critério '${name}' está '${passed}': sim ou não`);
      }
    }
  }

  if (/`<[^`]*>`/.test(text)) {
    problems.push("há campo do template ainda sem valor (`<…>`)");
  }

  return problems;
}

export {
  REPORT_NAME,
  STEPS,
  STEPS_NAMES,
  criteriaRows,
  digestsOf,
  fieldOf,
  judgeGate,
  peaksOf,
  renderReport,
  reportProblems,
  resultOf,
  sceneLines,
  sectionsOf,
  stealOf,
};

// ------------------------------------------------------------ the command

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const [command, ...args] = process.argv.slice(2);

  try {
    if (command === "scenes") {
      process.stdout.write(
        `${sceneLines(args[0], args[1] ?? "").join("\n")}\n`,
      );
      process.exit(0);
    }

    if (command === "render") {
      const [work, out] = args;
      const { markdown, result } = renderReport(work);

      writeFileSync(out, markdown);
      process.stdout.write(`${result}\n`);
      process.exit(0);
    }

    if (command === "check") {
      let failed = false;

      for (const file of args) {
        const problems = reportProblems(readFileSync(file, "utf8"), file);

        for (const problem of problems) {
          process.stderr.write(`${file}: ${problem}\n`);
        }

        failed ||= problems.length > 0;
      }

      process.exit(failed ? 1 : 0);
    }

    process.stderr.write(
      "uso: gate-report.mjs scenes <B|100k|1m|5m> [ids] | render <pasta> <relatório.md> | check <relatório.md>...\n",
    );
    process.exit(2);
  } catch (error) {
    process.stderr.write(`[gate] ${error.message}\n`);
    process.exit(2);
  }
}
