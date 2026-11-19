#!/usr/bin/env node
/**
 * What the realtime role runs, and the contract it speaks (plano-escala
 * F3-31c, decision D7).
 *
 * `trajetto-realtime` holds every socket. Deploying it drops them all (they
 * come back over the drain), so it is deployed only when what it runs
 * changed: the image carries two labels, computed here at build time, and
 * the deploy compares them with the image the realtime runs now
 * (.github/scripts/deploy-roles.sh):
 *
 *  - `trajetto.realtime-source`: a sha256 over the files of the realtime's
 *    import closure (from src/websocket.ts and the boot) plus what turns
 *    them into a running process: the dependencies (package.json's and
 *    yarn.lock), the Prisma schema (the client selects every column of a
 *    model it knows, so a realtime on an older schema would break on the
 *    contraction of a column it still selects) and the build config. A
 *    route outside the closure changes nothing here;
 *  - `trajetto.contract-epoch`: the migrations in the contract phase
 *    (`-- contract-phase:`) plus the versions of the messages between
 *    processes (src/shared/socket/messages.ts). It only grows: a new
 *    contraction or a new message version moves it, and a realtime on
 *    another epoch is deployed even when its own files did not change.
 *
 * The closure is followed through every static import, re-export and
 * literal `import()`/`require()`, type-only imports aside, from the roots
 * below; it stops at the BOUNDARIES, files the realtime role loads but never
 * runs (the routes besides /health, the workers, the import queue): their
 * own text is not in it, nor what only they import. The list is committed
 * in .github/realtime-closure.txt, so a review sees the closure grow;
 * tests/unitaires/lifecycle/realtime-closure.test.ts fails when it is out
 * of date.
 *
 *   node .github/scripts/realtime-closure.mjs --list     the closure, one file per line
 *   node .github/scripts/realtime-closure.mjs --write    rewrites .github/realtime-closure.txt
 *   node .github/scripts/realtime-closure.mjs --check    exit 1 when the committed list is stale
 *   node .github/scripts/realtime-closure.mjs --source   the realtime-source hash
 *   node .github/scripts/realtime-closure.mjs --epoch    the contract epoch
 *
 * Node only (no node_modules): it runs in the build job before the image.
 * ROOT (default: the working directory) is the repository it reads.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.env.REALTIME_CLOSURE_ROOT ?? process.cwd());

/** Where the realtime process starts: the sockets and the boot. */
const ROOTS = [
  "src/websocket.ts",
  "src/server.ts",
  "src/http.ts",
  // The only routes the realtime answers (src/shared/http/http-surface.ts).
  "src/routes/health-routes.ts",
];

/**
 * Loaded by the boot but never run by the realtime role (PROCESS_ROLE=
 * realtime: no workers, no cron, only /health*): followed no further.
 */
const BOUNDARIES = new Set([
  "src/routes/routes.ts",
  "src/workers/index.ts",
  "src/modules/import/services/import-queue.ts",
]);

/** What else turns the closure into the running process. */
const BUILD_INPUTS = [
  "package.json",
  "yarn.lock",
  "prisma/schema.prisma",
  "tsconfig.json",
  "tsup.config.ts",
];

const LIST_FILE = ".github/realtime-closure.txt";

const MESSAGES_FILE = "src/shared/socket/messages.ts";

const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** The module specifiers a file imports at run time. */
function specifiers(source) {
  const found = new Set();

  // `import x from "y"`, `import { a } from "y"`, `export * from "y"`,
  // `export { a } from "y"`; not `import type` / `export type`.
  const fromClause =
    /^\s*(import|export)\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;

  for (const match of source.matchAll(fromClause)) found.add(match[3]);

  // Side-effect imports: `import "y"`.
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    found.add(match[1]);
  }

  // Literal dynamic imports and requires.
  for (const match of source.matchAll(
    /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    found.add(match[1]);
  }

  return [...found];
}

/** The repository file a specifier names, or null for a package. */
function resolveSpecifier(from, specifier) {
  let base;

  if (specifier.startsWith("@/")) {
    base = posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith("infra/")) {
    base = specifier;
  } else if (specifier.startsWith(".")) {
    base = posix.join(posix.dirname(from), specifier);
  } else {
    return null;
  }

  base = posix.normalize(base);

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}.json`,
  ]) {
    if (
      existsSync(join(ROOT, candidate)) &&
      /\.(ts|js|json|mjs|cjs)$/.test(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

/** Every repository file the roots reach, sorted. */
function closure() {
  const seen = new Set();
  const queue = [...ROOTS];

  while (queue.length > 0) {
    const file = queue.shift();

    if (seen.has(file)) continue;

    seen.add(file);

    if (BOUNDARIES.has(file) || !/\.ts$/.test(file)) continue;

    for (const specifier of specifiers(read(file))) {
      const target = resolveSpecifier(file, specifier);

      if (target && !BOUNDARIES.has(target)) queue.push(target);
    }
  }

  return [...seen].filter((file) => !BOUNDARIES.has(file)).sort();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The realtime-source label: every file of the closure and the build's. */
function sourceHash(files = closure()) {
  const lines = [...files, ...BUILD_INPUTS]
    .filter((file) => existsSync(join(ROOT, file)))
    // A checkout with CRLF must hash as the repository's LF.
    .map((file) => `${file} ${sha256(read(file).replace(/\r\n/g, "\n"))}`);

  return sha256(`${lines.join("\n")}\n`);
}

/** The migrations that contract the schema (expand/contract's second half). */
function contractMigrations() {
  const dir = join(ROOT, "prisma", "migrations");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const sql = join(dir, name, "migration.sql");

      return (
        existsSync(sql) &&
        /--\s*contract-phase:/.test(readFileSync(sql, "utf8"))
      );
    })
    .sort();
}

/**
 * The versions in MESSAGE_VERSIONS of src/shared/socket/messages.ts, read
 * as text: `name: <integer>` lines inside the object.
 */
function messageVersions() {
  const text = read(MESSAGES_FILE);
  const block = /const MESSAGE_VERSIONS = \{([\s\S]*?)\}/.exec(text);

  if (!block) {
    throw new Error(`MESSAGE_VERSIONS não encontrado em ${MESSAGES_FILE}`);
  }

  const versions = {};

  for (const match of block[1].matchAll(
    /^\s*["']?([\w-]+)["']?\s*:\s*(\d+)\s*,?\s*$/gm,
  )) {
    versions[match[1]] = Number(match[2]);
  }

  return versions;
}

/** The contract epoch: contractions plus message versions; only grows. */
function contractEpoch() {
  const versions = Object.values(messageVersions());

  return (
    contractMigrations().length +
    versions.reduce((total, version) => total + version, 0)
  );
}

function listText(files = closure()) {
  return [
    "# The realtime role's import closure (plano-escala F3-31c).",
    "# Generated by: node .github/scripts/realtime-closure.mjs --write",
    "# A change in any of these files, or in the build inputs the script",
    "# names, deploys trajetto-realtime; anything else does not.",
    ...files,
    "",
  ].join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2];

  if (command === "--list") {
    process.stdout.write(`${closure().join("\n")}\n`);
  } else if (command === "--write") {
    writeFileSync(join(ROOT, LIST_FILE), listText());
  } else if (command === "--check") {
    const committed = existsSync(join(ROOT, LIST_FILE))
      ? read(LIST_FILE).replace(/\r\n/g, "\n")
      : "";

    if (committed !== listText()) {
      console.error(
        `::error::${LIST_FILE} está desatualizado: rode node .github/scripts/realtime-closure.mjs --write e versione o resultado.`,
      );
      process.exit(1);
    }
  } else if (command === "--source") {
    process.stdout.write(`${sourceHash()}\n`);
  } else if (command === "--epoch") {
    process.stdout.write(`${contractEpoch()}\n`);
  } else {
    console.error(
      "uso: realtime-closure.mjs --list | --write | --check | --source | --epoch",
    );
    process.exit(2);
  }
}

export {
  BOUNDARIES,
  BUILD_INPUTS,
  LIST_FILE,
  ROOTS,
  closure,
  contractEpoch,
  contractMigrations,
  listText,
  messageVersions,
  sourceHash,
  specifiers,
};
