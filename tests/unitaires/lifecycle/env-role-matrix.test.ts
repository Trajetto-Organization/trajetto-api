import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envShape } from "@/schemas/env-schema/defined-env";
import { PROCESS_ROLES } from "@/shared/lifecycle/process-role";

/**
 * The matrix of every variable by Application (plano-escala X-39, wave 21):
 * docs/variaveis-de-ambiente.md, "Matriz por Application".
 *
 * The environments are typed by hand into the Dokploy panel, one
 * Application at a time, and the GitHub environments the same way. Before
 * the staging moves to the second VPS and production to its own servers
 * (wave 22), they must be rebuilt from the documents alone. A key of the
 * env schema nobody placed in an Application, a secret a workflow reads
 * that is in no table, a secret typed as a variable, or a ceiling that
 * differs from deploy.md's table is a variable forgotten on the night of
 * the move: the process boots on a default, or the deploy skips a step
 * with a warning nobody reads. Everything here is plain fs.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const doc = read("docs/variaveis-de-ambiente.md");
const deploy = read("docs/deploy.md");

const NAME = /[A-Z][A-Z0-9_]*/.source;

/** The API image's Applications, one per role, in the matrix's order. */
const ROLE_APPLICATIONS = [
  ["`trajetto-api`", "api"],
  ["`trajetto-worker`", "worker"],
  ["`trajetto-scheduler`", "scheduler"],
  ["`trajetto-worker-external`", "worker-external"],
  ["`trajetto-realtime`", "realtime"],
  ["`trajetto-ingest`", "ingest"],
] as const;

const APPLICATIONS = [
  ...ROLE_APPLICATIONS.map(([application]) => application),
  "`trajetto-api-migrate`",
  "`trajetto-pgbouncer`",
];

/** `text` from `heading` up to the next heading of its level or above. */
function part(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);

  expect(start, heading).toBeGreaterThanOrEqual(0);

  const level = heading.match(/^(#+) /)![1].length;
  const next = new RegExp(`\\n#{1,${level}} `, "g");

  next.lastIndex = start + heading.length + 1;
  const match = next.exec(text);

  return text.slice(start, match ? match.index : undefined);
}

interface Table {
  header: string[];
  rows: string[][];
}

/** Cells of one table row; an escaped pipe stays inside its cell. */
const cells = (line: string) =>
  line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

/** The first table after `marker` in `text`, contiguous rows only. */
function firstTable(text: string, marker: string): Table {
  const start = text.indexOf(marker);

  expect(start, marker).toBeGreaterThanOrEqual(0);

  const rest = text.slice(start).split("\n");
  const first = rest.findIndex((line) => line.startsWith("|"));
  const after = rest.slice(first);
  const last = after.findIndex((line) => !line.startsWith("|"));
  const lines = last < 0 ? after : after.slice(0, last);

  return { header: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

/** The UPPER_CASE names in backticks of a cell. */
const namesIn = (cell: string) =>
  [...cell.matchAll(new RegExp(`\`(${NAME})\``, "g"))].map((m) => m[1]);

/** The names `.env.example` lists, commented ones included. */
function exampleNames(): Set<string> {
  return new Set(
    read(".env.example")
      .split("\n")
      .map((line) => line.match(new RegExp(`^#?\\s*(${NAME})=`))?.[1])
      .filter((name): name is string => !!name),
  );
}

const matrix = part(doc, "## Matriz por Application");
const keys = firstTable(part(matrix, "### Chaves por Application"), "| Chaves");
const keyNames = new Set(keys.rows.flatMap((row) => namesIn(row[0])));

describe("the keys by Application", () => {
  it("is listed in the summary", () => {
    expect(doc).toContain(
      "- [Matriz por Application](#matriz-por-application)",
    );
  });

  it("has one column per Application, then one per environment", () => {
    expect(keys.header).toEqual([
      "Chaves",
      ...APPLICATIONS,
      "Staging",
      "Produção",
    ]);

    for (const row of keys.rows) {
      expect(row, row[0]).toHaveLength(keys.header.length);
      expect(
        row.filter((cell) => cell === ""),
        row[0],
      ).toEqual([]);
    }
  });

  it("places every key of the env schema", () => {
    const missing = Object.keys(envShape()).filter(
      (name) => !keyNames.has(name),
    );

    expect(missing).toEqual([]);
  });

  it("places every variable of .env.example, outside the schema too", () => {
    const missing = [...exampleNames()].filter((name) => !keyNames.has(name));

    expect(missing).toEqual([]);
  });

  it("invents no name", () => {
    // A name outside the schema and the example is still real when the
    // sections 1 to 16 document it in a row of their own: the
    // RUN_MIGRATIONS_ON_BOOT kept `false` for a rollback to an old build.
    const documented = doc
      .replace(matrix, "")
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .flatMap((line) => namesIn(cells(line)[0]));
    const known = new Set([
      ...Object.keys(envShape()),
      ...exampleNames(),
      ...documented,
    ]);

    expect([...keyNames].filter((name) => !known.has(name))).toEqual([]);
  });

  it("places each key once", () => {
    const all = keys.rows.flatMap((row) => namesIn(row[0]));

    expect(all.filter((name, at) => all.indexOf(name) !== at)).toEqual([]);
  });

  it("gives each role's Application the PROCESS_ROLE of its role", () => {
    const row = keys.rows.find((cells) => cells[0] === "`PROCESS_ROLE`");

    expect(row, "a linha do PROCESS_ROLE").toBeDefined();

    // The api is `all` until the cut; the others are their own role.
    for (const [application, role] of ROLE_APPLICATIONS.slice(1)) {
      const cell = row![keys.header.indexOf(application)];

      expect(cell, application).toBe(`\`${role}\``);
      expect(PROCESS_ROLES).toContain(role);
    }

    expect(row![keys.header.indexOf("`trajetto-api`")]).toContain("`api`");
  });

  it("leaves the PgBouncer out of every key of the API image", () => {
    const column = keys.header.indexOf("`trajetto-pgbouncer`");
    const schema = new Set(Object.keys(envShape()));

    for (const row of keys.rows) {
      if (namesIn(row[0]).some((name) => schema.has(name))) {
        expect(row[column], row[0]).toBe("—");
      }
    }
  });
});

/** deploy.md's ceilings table (production or staging), by Application. */
function ceilings(marker: string, column: string): Map<string, string> {
  const table = firstTable(
    part(deploy, "### Tetos por Application e por fase"),
    marker,
  );
  const index = table.header.indexOf(column);

  expect(index, `${marker} → ${column}`).toBeGreaterThan(0);

  return new Map(
    table.rows.map((row) => {
      // "igual" carries the cell of the column before it.
      let at = index;

      while (row[at] === "igual") at -= 1;

      return [row[0], row[at]];
    }),
  );
}

describe("the Dokploy settings by Application", () => {
  const settings = firstTable(
    part(matrix, "### Configurações do Dokploy por Application"),
    "| Application",
  );
  const limits = firstTable(
    part(matrix, "### Configurações do Dokploy por Application"),
    "| Teto",
  );

  it("covers every Application, every field filled", () => {
    expect(settings.rows.map((row) => row[0])).toEqual(APPLICATIONS);
    expect(settings.header).toEqual([
      "Application",
      "Imagem (staging / produção)",
      "_Domain_ e _Path_",
      "_Stop Grace Period_",
      "_Health Check_",
      "_Restart_, _Update_ e _Rollback_",
      "_Placement_",
      "GitHub (secret e variable)",
    ]);

    for (const row of settings.rows) {
      expect(
        row.filter((cell) => cell === ""),
        row[0],
      ).toEqual([]);
    }
  });

  it("gives the API image's roles the 40 s grace and the PgBouncer 90 s", () => {
    const grace = settings.header.indexOf("_Stop Grace Period_");

    for (const row of settings.rows) {
      if (ROLE_APPLICATIONS.some(([application]) => application === row[0])) {
        expect(row[grace], row[0]).toContain("`40000000000`");
      }
    }

    expect(
      settings.rows.find((row) => row[0] === "`trajetto-pgbouncer`")![grace],
    ).toContain("`90000000000`");
  });

  it("puts a Domain with a Path only on the roles that take traffic", () => {
    const domain = settings.header.indexOf("_Domain_ e _Path_");

    for (const row of settings.rows) {
      const paths = row[domain].match(/`\/[\w./-]*`/g) ?? [];
      const expected: Record<string, string[]> = {
        "`trajetto-api`": ["`/`"],
        "`trajetto-realtime`": ["`/socket.io`"],
        "`trajetto-ingest`": ["`/route/positions`"],
      };

      expect(paths, row[0]).toEqual(expected[row[0]] ?? []);
    }
  });

  it("copies the ceilings of deploy.md, cell by cell", () => {
    const sources: Record<string, Map<string, string>> = {
      "Staging (2º VPS)": ceilings("**Staging**", "2º VPS (onda 16 em diante)"),
      "Produção (fase E, VPS 1)": ceilings("**Produção**", "E (VPS 1 sozinha)"),
      "Produção (prod-1)": ceilings("**Produção**", "prod-1"),
    };

    expect(limits.header).toEqual(["Teto", ...Object.keys(sources)]);
    expect(limits.rows.map((row) => row[0])).toEqual(APPLICATIONS);

    for (const row of limits.rows) {
      Object.values(sources).forEach((source, at) => {
        expect(row[at + 1], `${row[0]} → ${limits.header[at + 1]}`).toBe(
          source.get(row[0]),
        );
      });
    }
  });
});

function files(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) return files(path);

      return /\.ya?ml$/.test(entry.name) ? [path] : [];
    },
  );
}

/** Every `secrets.NAME` and `vars.NAME` the workflows and actions read. */
function workflowReads(): Map<string, "secret" | "variable"> {
  const reads = new Map<string, "secret" | "variable">();

  for (const file of files(".github")) {
    for (const match of read(file).matchAll(
      new RegExp(`\\b(secrets|vars)\\.(${NAME})\\b`, "g"),
    )) {
      reads.set(match[2], match[1] === "secrets" ? "secret" : "variable");
    }
  }

  return reads;
}

describe("the GitHub secrets and variables by environment", () => {
  const github = firstTable(
    part(matrix, "### Secrets e variáveis do GitHub por environment"),
    "| Nome",
  );
  const listed = new Map(
    github.rows.flatMap((row) =>
      namesIn(row[0]).map((name) => [name, row[1]] as const),
    ),
  );

  it("has a value for staging, for production and for the repository", () => {
    expect(github.header).toEqual([
      "Nome",
      "Tipo",
      "Staging",
      "Produção",
      "Repositório",
    ]);

    for (const row of github.rows) {
      expect(row, row[0]).toHaveLength(github.header.length);
    }
  });

  it("lists every secret and variable a workflow reads, with its kind", () => {
    const reads = workflowReads();

    expect(reads.size).toBeGreaterThan(20);

    for (const [name, kind] of reads) {
      expect(listed.get(name), name).toBe(
        name === "GITHUB_TOKEN" ? "automático" : kind,
      );
    }
  });

  it("lists nothing the workflows do not read", () => {
    const reads = workflowReads();

    expect([...listed.keys()].filter((name) => !reads.has(name))).toEqual([]);
  });
});

/**
 * The way back of a contraction branch (docs/deploy.md, "As branches das
 * contrações") goes on every Application whose process reads the variable.
 * SOCKET_POSITIONS_ON_OPERATIONS_ROOM counts in the process that answers
 * POST /route/positions, the one that emits the position: the trajetto-api
 * and, with the /route/positions Domain, the trajetto-ingest. A way back
 * typed on the trajetto-api alone left the points that arrive through the
 * ingest out of the operations room, half undone with no warning.
 */
describe("the way back of the positions' contraction (U-03)", () => {
  const branchRow = (branch: string) =>
    deploy
      .split("\n")
      .find((line) => line.startsWith(`| \`escala/contract-${branch}\``));

  it("names the trajetto-ingest beside the trajetto-api, in both steps", () => {
    for (const branch of ["U-03", "U-03-remove"]) {
      const row = branchRow(branch);

      expect(row, branch).toBeTruthy();
      expect(row, branch).toContain("`trajetto-api`");
      expect(row, branch).toContain("`trajetto-ingest`");
    }
  });
});

/** The matrix row that places `name`. */
function keyRow(name: string): string[] {
  const row = keys.rows.find((cells) => namesIn(cells[0]).includes(name));

  expect(row, name).toBeDefined();

  return row!;
}

const cellOf = (name: string, application: string) =>
  keyRow(name)[keys.header.indexOf(application)];

/**
 * With IMPORT_DURABLE_JOBS on, the trajetto-worker is the process that reads
 * the uploaded spreadsheets (plano-escala, wave 14). Its reads must run in a
 * thread with a heap ceiling of its own, `1` read with 128 MB in staging and
 * 320 MB in production: with `0` the worker reads on its main thread, and an
 * oversized workbook that should end one thread with a 413 kills the whole
 * worker (outbox, webhooks, AI, jobs) instead, again after every restart.
 */
describe("the spreadsheet reads on the trajetto-worker (F3-23b)", () => {
  it("gives the worker one read once the import is durable", () => {
    const worker = cellOf("SPREADSHEET_READS_PER_PROCESS", "`trajetto-worker`");

    expect(worker).not.toBe("`0`");
    expect(worker).toMatch(/importação durável/);
    expect(worker).toContain("`1`");
  });

  it("gives the worker's read thread its own ceiling, as deploy.md does", () => {
    const worker = cellOf("SPREADSHEET_WORKER_MAX_OLD_MB", "`trajetto-worker`");

    expect(worker).toContain("`128`");
    expect(worker).toContain("`320`");
    expect(deploy).toMatch(
      /`SPREADSHEET_READS_PER_PROCESS=1` e\s+`SPREADSHEET_WORKER_MAX_OLD_MB=320`/,
    );
  });

  it("says the same in section 1, staging and production", () => {
    const section = doc.replace(matrix, "");

    for (const name of [
      "SPREADSHEET_READS_PER_PROCESS",
      "SPREADSHEET_WORKER_MAX_OLD_MB",
    ]) {
      const line = section
        .split("\n")
        .find((text) => text.startsWith(`| \`${name}\``));

      expect(line, name).toBeTruthy();
      expect(line, name).toMatch(
        /`trajetto-worker`[^|]*importação durável|importação durável[^|]*`trajetto-worker`/,
      );
    }
  });
});

/**
 * The same key in the matrix: the trajetto-ingest emits the position, so a
 * `cópia` there ("the role may not even read it") would send the owner's
 * way back of U-03 to the trajetto-api alone.
 */
describe("the positions' room flag in the matrix (U-03)", () => {
  it("is not a copy on the trajetto-ingest", () => {
    expect(
      cellOf("SOCKET_POSITIONS_ON_OPERATIONS_ROOM", "`trajetto-ingest`"),
    ).toBe("igual à api");
    expect(
      cellOf("SOCKET_POSITIONS_ON_OPERATIONS_ROOM", "`trajetto-api`"),
    ).toBe("valor");
  });
});
