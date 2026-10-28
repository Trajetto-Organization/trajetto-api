import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The architecture docs, checked as data (spec §11.1 and §11.3).
 *
 * The READMEs and docs/ are read on GitHub, where a broken anchor or a
 * Mermaid `click` to a renamed section fails silently: the reader just lands
 * at the top of a page. And the step-by-step tour copies the component map
 * once per step, so the two drift the first time someone edits only one.
 * Everything here is plain fs: no app boot, no network.
 *
 * Anchors follow GitHub's slug rules (github-slugger): the heading's rendered
 * text, lower-cased, with everything but letters, marks, digits, spaces,
 * `_` and `-` removed, spaces turned into `-`, and `-1`, `-2`… on repeats.
 * Accented letters stay ("visão-de-componentes").
 */

const ROOT = process.cwd();
const ORG_BLOB =
  /^https:\/\/github\.com\/Trajetto-Organization\/(trajetto-api|trajetto-ui|trajetto-mobile)\/blob\/staging\/([^#?]+)(?:#(.*))?$/;
const TOUR = "docs/arquitetura-tour.md";
const MAP_DOC = "docs/arquitetura.md";

/** The sibling checkout of another repository, when it sits next to this one. */
function repoRoot(repo: string): string | null {
  if (repo === "trajetto-api") return ROOT;

  const sibling = resolve(ROOT, "..", repo);

  return existsSync(sibling) ? sibling : null;
}

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function markdownFiles(): string[] {
  const files = ["README.md"];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = posix.join(dir, name);

      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };

  walk("docs");

  return files;
}

interface Block {
  lang: string;
  lines: string[];
  /** 1-based line of the opening fence. */
  line: number;
}

/** Splits a Markdown file into prose lines and fenced code blocks. */
function parse(text: string): { prose: string[]; blocks: Block[] } {
  const prose: string[] = [];
  const blocks: Block[] = [];
  let open: Block | null = null;
  let fence = "";

  text.split("\n").forEach((raw, index) => {
    const marker = raw.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);

    if (open) {
      if (marker && marker[1].startsWith(fence) && !marker[2]) {
        blocks.push(open);
        open = null;
      } else {
        open.lines.push(raw);
      }

      prose.push("");
      return;
    }

    if (marker) {
      fence = marker[1];
      open = { lang: marker[2], lines: [], line: index + 1 };
      prose.push("");
      return;
    }

    prose.push(raw);
  });

  return { prose, blocks };
}

/** The text GitHub renders for a heading, before slugging it. */
function headingText(source: string): string {
  return source
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("`")
    .map((part, index) =>
      // Odd parts are code spans: their text is literal. Elsewhere `*` and an
      // `_` at a word edge are emphasis markers, which render as nothing.
      index % 2 === 1
        ? part
        : part
            .replace(/\*/g, "")
            .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1"),
    )
    .join("");
}

function githubSlug(heading: string): string {
  return headingText(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

const anchorCache = new Map<string, Set<string>>();

/** Every anchor a Markdown file exposes: its heading slugs and HTML ids. */
function anchorsOf(path: string): Set<string> {
  const cached = anchorCache.get(path);

  if (cached) return cached;

  const text = read(path);
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  for (const line of parse(text).prose) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);

    if (heading) {
      const base = githubSlug(heading[1]);
      const count = seen.get(base);

      seen.set(base, (count ?? -1) + 1);
      anchors.add(count === undefined ? base : `${base}-${count + 1}`);
    }

    for (const id of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) {
      anchors.add(id[1]);
    }
  }

  anchorCache.set(path, anchors);

  return anchors;
}

/** `[text](target)` targets in prose, with balanced parentheses in paths. */
function inlineLinks(line: string): string[] {
  const targets: string[] = [];
  // Inline code is not a link: `[a](b)` inside backticks is an example.
  const text = line.replace(/`[^`]*`/g, "");
  let from = 0;

  while (true) {
    const start = text.indexOf("](", from);

    if (start < 0) break;

    let depth = 1;
    let end = start + 2;

    while (end < text.length && depth > 0) {
      if (text[end] === "(") depth += 1;
      if (text[end] === ")") depth -= 1;
      end += 1;
    }

    const inner = text.slice(start + 2, end - 1).trim();
    // `<path with spaces>` or `path "title"`.
    const target = inner.startsWith("<")
      ? inner.slice(1, inner.indexOf(">"))
      : inner.split(/\s+/)[0];

    if (target) targets.push(target);
    from = end;
  }

  for (const reference of line.matchAll(/^\s*\[[^\]]+\]:\s+(\S+)/g)) {
    targets.push(reference[1]);
  }

  for (const href of line.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
    targets.push(href[1]);
  }

  return targets;
}

interface Resolution {
  /** Absolute path of the target file; null when it cannot be checked here. */
  file: string | null;
  anchor: string | null;
  external: boolean;
}

function resolveTarget(from: string, target: string): Resolution {
  const blob = target.match(ORG_BLOB);

  if (blob) {
    const root = repoRoot(blob[1]);

    return {
      file: root ? join(root, decodeURIComponent(blob[2])) : null,
      anchor: blob[3] ?? null,
      external: false,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return { file: null, anchor: null, external: true };
  }

  const [path, anchor] = target.split("#", 2);

  return {
    file: path
      ? join(ROOT, dirname(from), decodeURIComponent(path))
      : join(ROOT, from),
    anchor: anchor ?? null,
    external: false,
  };
}

/** Why a target does not resolve, or null when it does (or cannot be checked). */
function brokenReason(from: string, target: string): string | null {
  const { file, anchor, external } = resolveTarget(from, target);

  if (external || !file) return null;
  if (!existsSync(file)) return "missing file";

  if (anchor) {
    if (!file.endsWith(".md")) return null;

    const wanted = decodeURIComponent(anchor);

    if (!anchorsOf(file).has(wanted)) return `missing anchor #${wanted}`;
  }

  return null;
}

interface MermaidClick {
  id: string;
  target: string;
}

/** Node ids a Mermaid flowchart defines (`id[...]`, `id(...)`, `id{...}`). */
function mermaidNodeIds(lines: string[]): Set<string> {
  const ids = new Set<string>();

  for (const line of lines) {
    for (const node of line.matchAll(
      /(?:^|[\s>|-])([A-Za-z][\w]*)\s*(?:\[|\(|\{)/g,
    )) {
      ids.add(node[1]);
    }

    const subgraph = line.match(/^\s*subgraph\s+(\w+)/);

    if (subgraph) ids.add(subgraph[1]);
  }

  return ids;
}

function mermaidClicks(lines: string[]): MermaidClick[] {
  return lines.flatMap((line) => {
    const click = line.match(/^\s*click\s+(\w+)\s+(?:href\s+)?"([^"]+)"/);

    return click ? [{ id: click[1], target: click[2] }] : [];
  });
}

describe("links and anchors in README.md and docs/**/*.md", () => {
  const files = markdownFiles();

  it("finds the documents it is meant to check", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        MAP_DOC,
        TOUR,
        "docs/deploy.md",
        "docs/adr/README.md",
      ]),
    );
  });

  it("is not vacuous: it reads hundreds of links and catches a broken one", () => {
    const total = files
      .map((file) => parse(read(join(ROOT, file))).prose.flatMap(inlineLinks))
      .flat().length;

    expect(total).toBeGreaterThan(200);
    expect(
      brokenReason("README.md", "./docs/arquitetura.md#visão-de-componentes"),
    ).toBeNull();
    expect(
      brokenReason(
        "README.md",
        "./docs/arquitetura.md#vis%C3%A3o-de-componentes",
      ),
    ).toBeNull();
    expect(
      brokenReason("README.md", "./docs/arquitetura.md#não-existe"),
    ).toMatch(/anchor/);
    expect(brokenReason("README.md", "./docs/nao-existe.md")).toMatch(/file/);
    expect(
      brokenReason(
        "README.md",
        "https://github.com/Trajetto-Organization/trajetto-api/blob/staging/docs/arquitetura.md#nao-existe",
      ),
    ).toMatch(/anchor/);
  });

  it.each(files)("every relative link and #anchor resolves in %s", (file) => {
    const { prose } = parse(read(join(ROOT, file)));
    const broken: string[] = [];

    prose.forEach((line, index) => {
      for (const target of inlineLinks(line)) {
        const reason = brokenReason(file, target);

        if (reason) broken.push(`${index + 1}: ${target} (${reason})`);
      }
    });

    expect(broken).toEqual([]);
  });

  it.each(files)(
    "every Mermaid click in %s targets a defined node and an existing anchor",
    (file) => {
      const { blocks } = parse(read(join(ROOT, file)));
      const broken: string[] = [];

      for (const block of blocks.filter((b) => b.lang === "mermaid")) {
        const ids = mermaidNodeIds(block.lines);

        for (const click of mermaidClicks(block.lines)) {
          if (!ids.has(click.id)) {
            broken.push(`${block.line}: click on undefined node ${click.id}`);
          }

          const reason = brokenReason(file, click.target);

          if (reason) broken.push(`${block.line}: ${click.target} (${reason})`);
        }
      }

      expect(broken).toEqual([]);
    },
  );
});

describe("the GitHub slug rules the anchors rely on", () => {
  it.each([
    ["Visão de componentes", "visão-de-componentes"],
    ["Um processo, vários papéis", "um-processo-vários-papéis"],
    ["Decisões (ADRs)", "decisões-adrs"],
    ["11. Domínios, TLS e a borda", "11-domínios-tls-e-a-borda"],
    ["Passo 3 de 11 — Sessão e login", "passo-3-de-11--sessão-e-login"],
    [
      "Next.js 14: versão e avisos de segurança",
      "nextjs-14-versão-e-avisos-de-segurança",
    ],
    ["`trajetto-ai` (Application)", "trajetto-ai-application"],
    ["Índice", "índice"],
  ])("%s → #%s", (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });

  it("numbers a repeated heading -1, -2 like GitHub", () => {
    const path = join(ROOT, TOUR);
    const anchors = anchorsOf(path);

    // The tour repeats "Onde ler mais" under every step.
    expect(anchors.has("onde-ler-mais")).toBe(true);
    expect(anchors.has("onde-ler-mais-1")).toBe(true);
  });
});

/** The component map: the first Mermaid block of docs/arquitetura.md. */
function componentMap(): string[] {
  const block = parse(read(join(ROOT, MAP_DOC))).blocks.find(
    (b) => b.lang === "mermaid",
  );

  if (!block) throw new Error(`${MAP_DOC} has no Mermaid map`);

  return block.lines.map((line) => line.trim()).filter(Boolean);
}

const HIGHLIGHT_LINE = /^(classDef|class|linkStyle)\s/;

interface Step {
  number: number;
  total: number;
  title: string;
  anchor: string;
  body: string;
}

function tourText(): string {
  const path = join(ROOT, TOUR);

  // A missing tour fails the tests below, not the whole file's collection.
  return existsSync(path) ? read(path) : "";
}

function tourSteps(): Step[] {
  const text = tourText();
  const parts = text.split(/^(?=## )/m);
  const steps: Step[] = [];

  for (const part of parts) {
    const heading = part.match(/^## (Passo (\d+) de (\d+) — (.+))$/m);

    if (heading) {
      steps.push({
        number: Number(heading[2]),
        total: Number(heading[3]),
        title: heading[4],
        anchor: githubSlug(heading[1]),
        body: part,
      });
    }
  }

  return steps;
}

describe("the step-by-step tour (docs/arquitetura-tour.md)", () => {
  const steps = tourSteps();
  const map = componentMap();
  const mapIds = mermaidNodeIds(map);
  const edgeCount = map.filter((line) => /-->|-\.->/.test(line)).length;

  it("has numbered steps 1..M with the same M in every heading", () => {
    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps.map((step) => step.number)).toEqual(
      steps.map((_, index) => index + 1),
    );
    expect(new Set(steps.map((step) => step.total))).toEqual(
      new Set([steps.length]),
    );
  });

  it("lists every step in the index, in order", () => {
    const text = tourText();
    const index = text.split(/^## /m).find((part) => part.startsWith("Índice"));

    expect(index).toBeDefined();

    const linked = [...(index ?? "").matchAll(/\]\(#([^)]+)\)/g)]
      .map((m) => decodeURIComponent(m[1]))
      .filter((anchor) => anchor.startsWith("passo-"));

    expect(linked).toEqual(steps.map((step) => step.anchor));
  });

  it.each(steps.map((step) => [step.number, step] as const))(
    "step %i redraws the component map unchanged, with its own highlight",
    (_number, step) => {
      const block = parse(step.body).blocks.find((b) => b.lang === "mermaid");

      expect(block).toBeDefined();

      const lines = (block?.lines ?? [])
        .map((line) => line.trim())
        .filter(Boolean);
      const structure = lines.filter((line) => !HIGHLIGHT_LINE.test(line));
      const highlight = lines.filter((line) => HIGHLIGHT_LINE.test(line));

      // Same ids, labels, edges and clicks as the map, in the same order, so
      // the layout holds still from one step to the next.
      expect(structure).toEqual(map);

      const focused = highlight
        .filter((line) => /^class\s.+\sfoco$/.test(line))
        .flatMap((line) =>
          line
            .replace(/^class\s+/, "")
            .replace(/\s+foco$/, "")
            .split(","),
        )
        .map((id) => id.trim());

      expect(focused.length).toBeGreaterThan(0);

      for (const line of highlight.filter((l) => /^class\s/.test(l))) {
        const ids = line
          .replace(/^class\s+/, "")
          .replace(/\s+\w+$/, "")
          .split(",");

        for (const id of ids) expect(mapIds).toContain(id.trim());
      }

      for (const line of highlight.filter((l) => l.startsWith("linkStyle"))) {
        const indexes = line.split(/\s+/)[1].split(",").map(Number);

        for (const index of indexes) {
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(edgeCount);
        }
      }
    },
  );

  it.each(steps.map((step) => [step.number, step] as const))(
    "step %i links to the previous step, the index and the next step",
    (_number, step) => {
      const previous = steps[step.number - 2];
      const next = steps[step.number];
      const nav = step.body
        .split("\n")
        .filter((line) => line.includes("[Índice](#índice)"));

      expect(nav.length).toBeGreaterThanOrEqual(1);

      for (const line of nav) {
        if (previous) expect(line).toContain(`](#${previous.anchor})`);
        else expect(line).not.toContain("Anterior");

        if (next) expect(line).toContain(`](#${next.anchor})`);
        else expect(line).not.toContain("Próximo");
      }
    },
  );

  it("cites only paths that exist (this repository and, when present, its siblings)", () => {
    const text = tourText();
    const missing: string[] = [];
    const repoPath =
      /`((?:trajetto-(?:api|ui|mobile)\/)?(?:src|infra|tests|prisma|docs|scripts|\.github|features|providers|utils|modules|hooks)\/[^`\s]*)`/g;

    for (const match of text.matchAll(repoPath)) {
      const cited = match[1].replace(/[:#].*$/, "");
      const sibling = cited.match(/^(trajetto-(?:api|ui|mobile))\/(.+)$/);
      const root = sibling ? repoRoot(sibling[1]) : ROOT;

      if (!root) continue;

      const path = join(root, sibling ? sibling[2] : cited);

      if (!existsSync(path)) missing.push(match[1]);
    }

    expect(missing).toEqual([]);
  });

  it("mentions RabbitMQ only as the removed legacy", () => {
    const text = tourText();
    // Judged per paragraph, list item or table row, so line wrapping does not
    // split "RabbitMQ" from the word that dates it.
    const blocks = text
      .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)|\n(?=\|)/)
      .filter((block) => /rabbitmq/i.test(block))
      .filter(
        (block) => !/legad|removid|saiu|antig|não há|sem broker/i.test(block),
      );

    expect(blocks).toEqual([]);
  });
});

describe("every ADR the code and the docs cite has its file", () => {
  const ADR_DIR = join(ROOT, "docs/adr");
  const files = existsSync(ADR_DIR) ? readdirSync(ADR_DIR) : [];
  const numbers = new Set(
    files.map((name) => name.match(/^(\d{4})-.+\.md$/)?.[1]).filter(Boolean),
  );

  const SKIP = new Set([
    "node_modules",
    "build",
    "coverage",
    ".git",
    ".stryker-tmp",
    "dist",
    ".next",
  ]);
  const TEXT =
    /\.(ts|tsx|mts|mjs|js|md|mdx|prisma|sql|py|txt|ya?ml|gradle|json)$|^Dockerfile$|^\.env\.example$|^\.dockerignore$/;

  function cited(root: string, dirs: string[]): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (path: string) => {
      const stat = statSync(path);

      if (stat.isDirectory()) {
        for (const name of readdirSync(path)) {
          if (!SKIP.has(name)) visit(join(path, name));
        }

        return;
      }

      const name = path.split(/[\\/]/).pop() ?? "";

      if (!TEXT.test(name) || stat.size > 2_000_000) return;

      const text = readFileSync(path, "utf8");

      for (const match of text.matchAll(
        /\bADRs?\s+(\d{4}(?:\s*(?:\/|,|e|and)\s*\d{4})*)|docs\/adr\/(\d{4})/g,
      )) {
        for (const number of (match[1] ?? match[2]).match(/\d{4}/g) ?? []) {
          if (!found.has(number)) found.set(number, relative(root, path));
        }
      }
    };

    for (const dir of dirs) {
      const path = join(root, dir);

      if (existsSync(path)) visit(path);
    }

    return found;
  }

  it("has an index of the ADRs", () => {
    expect(files).toContain("README.md");
  });

  it.each([
    [
      "trajetto-api",
      [
        ".github",
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        "docs",
        "infra",
        "prisma",
        "scripts",
        "src",
        "tests",
        ".env.example",
        ".dockerignore",
        "compose.development.yaml",
      ],
    ],
    ["trajetto-ui", ["README.md", "docs", "src", "tests"]],
    ["trajetto-mobile", ["README.md", "docs", "modules", "features", "utils"]],
  ] as const)(
    "every ADR number cited in %s exists in docs/adr",
    (repo, dirs) => {
      const root = repoRoot(repo);

      if (!root) return;

      const missing = [...cited(root, [...dirs])]
        .filter(([number]) => !numbers.has(number))
        .map(([number, where]) => `ADR ${number} (${where})`);

      expect(missing).toEqual([]);
    },
  );
});

describe("claims the docs make about the code", () => {
  const readme = read(join(ROOT, "README.md"));
  const architecture = read(join(ROOT, MAP_DOC));

  it("do not say Redis holds no cache while the snapshot cache exists", () => {
    expect(existsSync(join(ROOT, "src/shared/cache/snapshot-cache.ts"))).toBe(
      true,
    );

    for (const text of [readme, architecture]) {
      expect(text).not.toMatch(/Não há cache no Redis/i);
      expect(text).not.toMatch(/sem cache, sessão, lock nem fila/i);
      expect(text).not.toMatch(/não há camada de cache na API nem no Redis/i);
    }
  });

  it("count the Redis uses right and describe the legacy broker as main had it", () => {
    expect(architecture).not.toMatch(/tem três usos/);
    expect(architecture).not.toMatch(/servia só o e-mail/);
    expect(architecture).toMatch(/whatsappQueue/);
    expect(architecture).toMatch(/aiVerificationQueue/);
  });

  it("point to the versioned ADR folder, not the empty workspace one", () => {
    expect(architecture).not.toMatch(/vivem na pasta `docs\/` da raiz/);
    expect(readme).not.toMatch(/texto\s+integral dos ADRs não está versionado/);
    expect(architecture).toMatch(/\]\(\.\/adr\/README\.md\)/);
  });

  it("link the tour from the README and from the map", () => {
    expect(readme).toMatch(/\]\(\.\/docs\/arquitetura-tour\.md\)/);
    expect(architecture).toMatch(/\]\(\.\/arquitetura-tour\.md\)/);
  });
});

/** `![label](https://img.shields.io/badge/<label>-<version>-<color>…)` */
function badges(text: string): { label: string; version: string }[] {
  return [...text.matchAll(/img\.shields\.io\/badge\/([^"?)\s]+)/g)].map(
    (match) => {
      // shields.io: `-` separates the fields, `--` is a literal dash, `_` a space.
      const fields = match[1]
        .replace(/--/g, "\u0000")
        .split("-")
        .map((field) =>
          decodeURIComponent(field.replace(/\u0000/g, "-").replace(/_/g, " ")),
        );

      return { label: fields[0], version: fields.length > 2 ? fields[1] : "" };
    },
  );
}

describe("the README badges name only what the repository runs", () => {
  const readme = read(join(ROOT, "README.md"));
  const found = badges(readme);
  const pkg = JSON.parse(read(join(ROOT, "package.json"))) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dockerfile = read(join(ROOT, "Dockerfile"));
  const aiDockerfile = read(join(ROOT, "infra/ai-ocr/Dockerfile"));
  const compose = read(join(ROOT, "compose.development.yaml"));
  const onnx = read(join(ROOT, "infra/ai-ocr/requirements-onnxruntime.txt"));

  const SOURCES: Record<string, string> = {
    "Node.js": dockerfile.match(/FROM node:(\d+\.\d+\.\d+)/)?.[1] ?? "",
    TypeScript: deps.typescript,
    Fastify: deps.fastify,
    Prisma: deps.prisma,
    PostgreSQL: compose.match(/postgres:(\d+)/)?.[1] ?? "",
    Redis: compose.match(/redis:(\d+)/)?.[1] ?? "",
    "Socket.IO": deps["socket.io"],
    Zod: deps.zod,
    Vitest: deps.vitest,
    Python: aiDockerfile.match(/FROM python:(\d+\.\d+)/)?.[1] ?? "",
    "ONNX Runtime": onnx.match(/onnxruntime==(\S+)/)?.[1] ?? "",
  };

  it("has the badge row", () => {
    expect(found.length).toBeGreaterThanOrEqual(8);
  });

  it("never names a technology this repository dropped", () => {
    const labels = found.map((badge) => badge.label.toLowerCase());

    for (const gone of ["rabbitmq", "anthropic", "evolution", "osrm"]) {
      expect(labels.some((label) => label.includes(gone))).toBe(false);
    }
  });

  it.each(Object.keys(SOURCES))(
    "pins %s to the version the repository uses",
    (label) => {
      const badge = found.find((b) => b.label === label);

      expect(badge, `badge ${label}`).toBeDefined();
      expect(SOURCES[label], `source of ${label}`).toBeTruthy();
      // A badge names a prefix (22, 5.7) of the exact version (22.21.1, 5.7.2).
      expect(`${SOURCES[label]}.`.startsWith(`${badge?.version}.`)).toBe(true);
    },
  );
});
