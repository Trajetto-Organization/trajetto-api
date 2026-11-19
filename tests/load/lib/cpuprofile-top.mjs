import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The top of one or more V8 CPU profiles (`node --cpu-prof`), as text a
 * person reads without a flame graph (plano-escala LOAD-10). The profiles of
 * the replicas of tests/load/cpu-profile.sh are merged: the question is
 * where the API's CPU goes under load, not one replica's.
 *
 *   node tests/load/lib/cpuprofile-top.mjs [--last S] [--skip-tail S]
 *     [--top N] [--match REGEX] [--requests N] [--json] <file>...
 *
 * --last S        only the S seconds before the cut (the measured window)
 * --skip-tail S   the cut is S seconds before each profile's end (the
 *                 shutdown after the load; the boot is before the window)
 * --top N         rows of each table (25)
 * --match REGEX   the share of the CPU spent under a frame whose function or
 *                 file matches (e.g. the session: "ensureAuthenticated|
 *                 loadSession"), counted once per sample however deep
 * --requests N    k6's requests in the window: the CPU per request
 *
 * A sample lasts until the next one (the last, until the profile's end), as
 * DevTools counts it. "(idle)" is the loop waiting, not CPU, and is left
 * out of every share; "(program)" (V8 and native code outside JavaScript)
 * and "(garbage collector)" are CPU and stay in. The profile is the main
 * thread's: the libuv pool and the worker threads are not in it.
 */

const IDLE = "(idle)";
const ROOT = "(root)";
const PROGRAM = "(program)";
const GC = "(garbage collector)";

/** Where a frame lives, short: the app's file, a package, node's own. */
function locationOf(callFrame) {
  const url = String(callFrame.url ?? "");

  if (!url) return "(nativo)";

  const path = url.replace(/^file:\/\//, "").replace(/^\/app\//, "");
  const line = Number(callFrame.lineNumber ?? -1) + 1;

  return line > 0 ? `${path}:${line}` : path;
}

/** The package a frame's self time is charged to. */
function packageOf(callFrame) {
  const name = callFrame.functionName;
  const url = String(callFrame.url ?? "");

  if (name === GC) return "(coletor de lixo)";
  if (name === PROGRAM) return "(programa: V8 e código nativo)";
  if (!url || url.startsWith("node:")) return "node (interno e nativo)";
  if (url.startsWith("wasm://")) return "WebAssembly";

  const at = url.lastIndexOf("/node_modules/");

  if (at >= 0) {
    const [first, second] = url.slice(at + "/node_modules/".length).split("/");

    return first.startsWith("@") ? `${first}/${second}` : first;
  }

  return `aplicação (${url.replace(/^file:\/\//, "").replace(/^\/app\//, "")})`;
}

const keyOf = (callFrame) =>
  `${callFrame.functionName || "(anônima)"} ${locationOf(callFrame)}`;

/**
 * Self time per node of one profile, in microseconds, inside the window.
 * The window ends `skipTailUs` before the profile's end and, with
 * `lastUs`, starts that long before its end.
 */
function selfTimes(profile, { lastUs = null, skipTailUs = 0 } = {}) {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const end = Number(profile.endTime) - skipTailUs;
  const start = lastUs === null ? -Infinity : end - lastUs;
  const self = new Map();

  let at = Number(profile.startTime);
  const stamps = samples.map((_, index) => (at += Number(deltas[index] ?? 0)));

  samples.forEach((id, index) => {
    const stamp = stamps[index];

    if (stamp < start || stamp >= end) return;

    const next =
      index + 1 < stamps.length ? stamps[index + 1] : Number(profile.endTime);
    const lasted = Math.max(0, Math.min(next, end) - stamp);

    self.set(id, (self.get(id) ?? 0) + lasted);
  });

  return self;
}

/** The merged top of the profiles. */
function analyze(profiles, options = {}) {
  const lastUs = options.lastSeconds ? options.lastSeconds * 1e6 : null;
  const skipTailUs = (options.skipTailSeconds ?? 0) * 1e6;
  const matcher = options.match ? new RegExp(options.match) : null;

  const bySelf = new Map();
  const byTotal = new Map();
  const byPackage = new Map();
  let cpuUs = 0;
  let idleUs = 0;
  let programUs = 0;
  let gcUs = 0;
  let matchedUs = 0;

  const add = (map, key, value, extra) => {
    const entry = map.get(key) ?? { ...extra, us: 0 };

    entry.us += value;
    map.set(key, entry);
  };

  for (const profile of profiles) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parent = new Map();

    for (const node of profile.nodes) {
      for (const child of node.children ?? []) parent.set(child, node.id);
    }

    const self = selfTimes(profile, { lastUs, skipTailUs });

    for (const [id, us] of self) {
      const node = nodes.get(id);

      if (!node || us === 0) continue;

      const frame = node.callFrame;

      if (frame.functionName === IDLE) {
        idleUs += us;
        continue;
      }

      if (frame.functionName === ROOT) continue;

      cpuUs += us;
      if (frame.functionName === PROGRAM) programUs += us;
      if (frame.functionName === GC) gcUs += us;

      const key = keyOf(frame);
      const shown = {
        name: frame.functionName || "(anônima)",
        location: locationOf(frame),
      };

      add(bySelf, key, us, shown);
      add(byPackage, packageOf(frame), us, { name: packageOf(frame) });

      // Up the stack: each function once per sample, however recursive.
      const seen = new Set();
      let matched = false;

      for (let at = id; at !== undefined; at = parent.get(at)) {
        const up = nodes.get(at)?.callFrame;

        if (!up || up.functionName === ROOT) continue;

        const upKey = keyOf(up);

        if (!seen.has(upKey)) {
          seen.add(upKey);
          add(byTotal, upKey, us, {
            name: up.functionName || "(anônima)",
            location: locationOf(up),
          });
        }

        if (
          matcher &&
          !matched &&
          matcher.test(`${up.functionName} ${locationOf(up)}`)
        )
          matched = true;
      }

      if (matched) matchedUs += us;
    }
  }

  const top = Number(options.top ?? 25);
  const ranked = (map) =>
    [...map.values()]
      .sort((a, b) => b.us - a.us)
      .slice(0, top)
      .map(({ us, ...rest }) => ({
        ...rest,
        ms: us / 1000,
        share: cpuUs > 0 ? (us / cpuUs) * 100 : 0,
      }));

  const requests = Number(options.requests ?? 0);

  return {
    profiles: profiles.length,
    window: {
      lastSeconds: options.lastSeconds ?? null,
      skipTailSeconds: options.skipTailSeconds ?? 0,
    },
    cpuMs: cpuUs / 1000,
    idleMs: idleUs / 1000,
    programShare: cpuUs > 0 ? (programUs / cpuUs) * 100 : 0,
    gcShare: cpuUs > 0 ? (gcUs / cpuUs) * 100 : 0,
    perRequestMs: requests > 0 ? cpuUs / 1000 / requests : null,
    requests: requests > 0 ? requests : null,
    match: matcher
      ? {
          pattern: options.match,
          ms: matchedUs / 1000,
          share: cpuUs > 0 ? (matchedUs / cpuUs) * 100 : 0,
        }
      : null,
    packages: ranked(byPackage),
    self: ranked(bySelf),
    total: ranked(byTotal),
  };
}

function num(value, digits) {
  const [whole, fraction] = Math.abs(value).toFixed(digits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${value < 0 ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

/** The analysis as markdown. */
function renderTop(result) {
  const out = ["# Perfil de CPU", ""];
  const { window } = result;

  out.push(`- Perfis: ${result.profiles} (um por réplica, somados)`);
  out.push(
    window.lastSeconds
      ? `- Janela: os ${window.lastSeconds} s antes do corte, ${window.skipTailSeconds} s antes do fim de cada perfil`
      : `- Janela: o perfil inteiro, menos os ${window.skipTailSeconds} s do fim`,
  );
  out.push(
    `- CPU amostrada da thread principal: ${num(result.cpuMs, 0)} ms (ocioso fora: ${num(result.idleMs, 0)} ms)`,
  );
  if (result.perRequestMs !== null)
    out.push(
      `- Por requisição: ${num(result.perRequestMs, 2)} ms (${num(result.requests, 0)} requisições)`,
    );
  out.push(
    `- Coletor de lixo: ${num(result.gcShare, 1)}%; (program), V8 e código nativo: ${num(result.programShare, 1)}%`,
  );
  if (result.match)
    out.push(
      `- Sob \`${cell(result.match.pattern)}\`: ${num(result.match.share, 1)}% da CPU (${num(result.match.ms, 0)} ms)`,
    );
  out.push("");

  out.push("## Por pacote (tempo próprio)", "");
  out.push("| Pacote | ms | % |", "| --- | --- | --- |");
  for (const row of result.packages)
    out.push(
      `| ${cell(row.name)} | ${num(row.ms, 0)} | ${num(row.share, 1)} |`,
    );
  out.push("");

  for (const [title, rows] of [
    ["Funções por tempo próprio", result.self],
    ["Funções por tempo total (com o que chamam)", result.total],
  ]) {
    out.push(`## ${title}`, "");
    out.push(
      "| # | Função | Onde | ms | % |",
      "| --- | --- | --- | --- | --- |",
    );
    rows.forEach((row, index) =>
      out.push(
        `| ${index + 1} | ${cell(row.name)} | ${cell(row.location)} | ${num(row.ms, 0)} | ${num(row.share, 1)} |`,
      ),
    );
    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/** argv → options and files; throws on what it cannot read. */
function parseArgs(argv) {
  const options = { top: 25 };
  const files = [];
  const number = (flag, value) => {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`${flag} precisa de um número: '${value}'`);

    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--last":
        options.lastSeconds = number(arg, argv[++i]);
        break;
      case "--skip-tail":
        options.skipTailSeconds = number(arg, argv[++i]);
        break;
      case "--top":
        options.top = number(arg, argv[++i]);
        break;
      case "--requests":
        options.requests = number(arg, argv[++i]);
        break;
      case "--match":
        options.match = argv[++i];
        new RegExp(options.match);
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`opção desconhecida: ${arg}`);
        files.push(arg);
    }
  }

  if (files.length === 0) throw new Error("nenhum perfil (.cpuprofile) dado");

  return { options, files };
}

export { analyze, packageOf, parseArgs, renderTop, selfTimes };

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  let parsed;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[cpuprofile-top] ${error.message}`);
    process.exit(2);
  }

  const profiles = parsed.files.map((file) =>
    JSON.parse(readFileSync(file, "utf8")),
  );
  const result = analyze(profiles, parsed.options);

  process.stdout.write(
    parsed.options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderTop(result),
  );
}
