import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envShape } from "@/schemas/env-schema/defined-env";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The PITR's operation guide against the image it operates (plano-escala
 * F1-19).
 *
 * docs/deploy.md §27 is run by hand, in the small hours, on the Database of
 * staging and then of production: the F1a, the swap of production's image
 * without archiving, the F1b, the Schedule Jobs and the reversal. A command
 * the image does not have, an option a script refuses, a variable nothing
 * reads or a "SHOW shared_buffers" the wrapper no longer derives would only
 * show there, with the Database half switched. So the section is read as
 * data here: every command against the scripts of infra/postgres, every
 * variable name against what the scripts read and what
 * docs/variaveis-de-ambiente.md documents, and the table of values through
 * trajetto-entrypoint.sh itself.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const deploy = read("docs/deploy.md");
const variables = read("docs/variaveis-de-ambiente.md");
const entrypoint = read("infra/postgres/trajetto-entrypoint.sh");
const backupScript = read("infra/postgres/bin/trajetto-backup");
const drillScript = read("infra/postgres/bin/trajetto-restore-drill");
const dockerfile = read("infra/postgres/Dockerfile");
const conf = read("infra/postgres/pgbackrest.conf");

/** A `## ` section of a Markdown text, from its heading to the next one. */
function section(text: string, heading: string): string {
  const parts = text.split(/^(?=## )/m);
  const found = parts.filter((part) => part.startsWith(`## ${heading}`));

  expect(found, heading).toHaveLength(1);

  return found[0];
}

/** A `### ` part of a section, from its heading to the next one. */
function subsection(text: string, heading: string): string {
  const found = text
    .split(/^(?=### )/m)
    .filter((part) => part.startsWith(`### ${heading}`));

  expect(found, heading).toHaveLength(1);

  return found[0];
}

/**
 * The built-in roles that run a program or read or write a file of the
 * Database's server: with one of them, `COPY … FROM PROGRAM 'env'` or
 * `pg_read_file('/proc/self/environ')` hands over the PITR keys.
 */
const SERVER_ROLES = [
  "pg_execute_server_program",
  "pg_read_server_files",
  "pg_write_server_files",
];

const PITR = section(deploy, "27. PITR com pgBackRest");
const BACKUP = section(deploy, "18. Backup e restauração");
const DATABASE_VARIABLES = section(variables, "14. Backup do banco");

/** Fenced code and inline code of a text, table pipes unescaped. */
function commands(text: string): string[] {
  const fenced = [...text.matchAll(/^ *```(?:sh|sql)\n([\s\S]*?)^ *```/gm)]
    .flatMap((match) => match[1].split("\n"))
    .map((line) => line.trim());
  const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((match) =>
    match[1].replace(/\\\|/g, "|"),
  );

  return [...fenced, ...inline].filter(Boolean);
}

const PITR_COMMANDS = commands(PITR);

const STANZA = [...conf.matchAll(/^\[([a-z0-9_-]+)\]$/gm)]
  .map((match) => match[1])
  .filter((name) => name !== "global" && !name.startsWith("global:"))[0];

/** The names a script assigns itself: shell variables, not environment. */
function ownVariables(script: string): Set<string> {
  return new Set(
    [...script.matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );
}

/** Every Database variable the image reads, from the scripts themselves. */
function databaseVariables(): Set<string> {
  const names = new Set<string>();

  for (const script of [entrypoint, backupScript, drillScript]) {
    const own = ownVariables(script);

    // A name followed by `$` or `@` is the prefix of a built one
    // (`${PGBACKREST_REPO${n}_TYPE}`, `${!PITR_@}`), added below.
    for (const match of script.matchAll(
      /\$\{?!?(POSTGRES_[A-Z0-9_]+|PITR_[A-Z0-9_]+|PGBACKREST_[A-Z0-9_]+)(?![A-Z0-9_$@])/g,
    )) {
      if (!own.has(match[1])) names.add(match[1]);
    }
  }

  // repo1 as the entrypoint requires it, by type (the names are built).
  const s3 = /s3\) set -- ([A-Z0-9_ ]+);;/.exec(entrypoint)?.[1].trim();

  expect(s3, "trajetto-entrypoint.sh: a lista do repo s3").toBeTruthy();

  for (const part of s3!.split(/\s+/)) names.add(`PGBACKREST_REPO1_${part}`);

  // The drill's read-only key, swapped in for the write key.
  const parts = /for part in ([A-Z0-9_ ]+); do/.exec(drillScript)?.[1].trim();

  expect(drillScript).toContain("PITR_DRILL_REPO${n}_${part}");

  for (const part of parts!.split(/\s+/)) names.add(`PITR_DRILL_REPO1_${part}`);

  // Set by the Dokploy Database's own fields, not typed by hand.
  for (const official of ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"])
    names.delete(official);

  return names;
}

const DATABASE_ENV = databaseVariables();

describe("section 27 of the deploy guide", () => {
  it("is in the guide's index", () => {
    expect(deploy).toContain(
      "27. [PITR com pgBackRest](#27-pitr-com-pgbackrest)",
    );
  });

  it("runs trajetto-backup only with the types the script takes", () => {
    const accepted = /case "\$TYPE" in\n\s+full \| diff\) shift ;;/.test(
      backupScript,
    );
    const used = PITR_COMMANDS.flatMap((line) =>
      [...line.matchAll(/trajetto-backup (\S+)/g)].map((match) => match[1]),
    );

    expect(accepted).toBe(true);
    expect(new Set(used)).toEqual(new Set(["full", "diff"]));
  });

  it("starts the drill exactly as the script's own header says, from where the image puts it", () => {
    const drill =
      'docker exec "$c" cat /usr/local/bin/trajetto-restore-drill | bash -s -- --from "$c"';

    expect(drillScript).toContain(`#     ${drill}`);
    expect(dockerfile).toMatch(
      /COPY --link --chmod=0755 bin\/trajetto-backup bin\/trajetto-restore-drill \/usr\/local\/bin\//,
    );
    // By hand (step 9) and in the monthly Schedule Job.
    expect(
      PITR_COMMANDS.filter((line) => line.includes(drill)).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("calls pgbackrest with the image's stanza, as postgres, and only commands it has", () => {
    const known = new Set([
      "stanza-create",
      "check",
      "info",
      "archive-get",
      "expire",
      "repo-get",
      "backup",
    ]);
    const calls = PITR_COMMANDS.filter((line) =>
      /(^|\s)pgbackrest\s/.test(line),
    );

    expect(STANZA).toBe("trajetto");
    expect(calls.length).toBeGreaterThan(5);

    for (const line of calls) {
      expect(line, line).toContain(`pgbackrest --stanza=${STANZA} `);
      // pgBackRest refuses to run as root, and `docker exec` is root.
      expect(line, line).toMatch(/docker exec -u postgres /);

      const command = /pgbackrest --stanza=\S+ (\S+)/.exec(line)?.[1] ?? "";

      expect(known.has(command), line).toBe(true);
    }
  });

  it("finds the Database by the Swarm label the scripts document", () => {
    const finders = PITR_COMMANDS.filter((line) => line.includes("docker ps"));

    expect(finders.length).toBeGreaterThan(0);

    for (const line of finders) {
      expect(line, line).toMatch(
        /docker ps -q -f label=com\.docker\.swarm\.service\.name=trajetto-postgres-(staging|production)\)/,
      );
    }

    expect(backupScript).toContain(
      "docker ps -q -f label=com.docker.swarm.service.name=",
    );
  });

  it("names only variables the image or the API reads", () => {
    const api = new Set(Object.keys(envShape()));
    const named = new Set(
      [
        ...PITR.matchAll(
          /\b(POSTGRES_[A-Z0-9_]+|PITR_[A-Z0-9_]+|PGBACKREST_[A-Z0-9_]+)\b/g,
        ),
      ].map((match) => match[1]),
    );
    const unknown = [...named].filter(
      (name) => !DATABASE_ENV.has(name) && !api.has(name),
    );

    expect(named.size).toBeGreaterThan(10);
    expect(unknown).toEqual([]);
  });

  it("states the values the wrapper derives, for each environment", () => {
    // Checked through the wrapper below; here only that the table is whole.
    const table = valuesTable();

    expect(table.columns).toEqual([
      "Staging (F1a)",
      "Produção, troca (onda 3)",
      "Produção, F1b (onda 6)",
    ]);

    for (const [index, limit] of table
      .row("`POSTGRES_MEMORY_LIMIT_MB`")
      .entries()) {
      const bytes = Number(code(table.row("_Memory Limit_")[index]));

      expect(bytes).toBe(Number(code(limit)) * 1_048_576);
    }
  });

  it("keeps the weekly and monthly schedules out of section 18", () => {
    // The web's legal-facts reads every cron of a section that states the
    // dump's Keep Latest as the dump's schedule, and demands a daily one.
    const cron = /`((?:[\d*/,-]+ ){4}[\d*/,-]+)`/g;
    const own = [...PITR.matchAll(cron)].map((match) => match[1]);

    expect(new Set(own)).toEqual(
      new Set(["0 5 * * 0-5", "0 5 * * 6", "45 5 1 * *"]),
    );
    expect(PITR).not.toContain("Keep Latest");

    for (const schedule of [...BACKUP.matchAll(cron)].map((m) => m[1])) {
      expect(schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    }
  });

  it("judges the acceptance on the fields the cluster row writes", () => {
    const sample = read("src/shared/health/cluster-sample.ts");
    const metrics = read("src/shared/health/database-metrics.ts");

    expect(PITR).toContain("metrics->'database'->>'archive_mode'");
    expect(PITR).toContain("metrics->'database'->'archiver'->>'failed_count'");
    expect(PITR).toContain(
      "metrics->'database'->'archiver'->>'last_archived_age_seconds'",
    );
    expect(sample).toMatch(
      /archive_mode: database\.parameters\?\.archive_mode/,
    );
    expect(sample).toMatch(/archiver: database\.archiver,/);
    expect(metrics).toMatch(/failed_count: number \| null;/);
    expect(metrics).toMatch(/last_archived_age_seconds: number \| null;/);
  });

  it("has the F1b prove the runtime cut and the lock before the keys go into the Database", () => {
    // D61 and F1-25: the F1b's step 1 writes the repository's write key and
    // cipher into the environment of the Database's container. A login that
    // can run a program or read a server file (a superuser, or a member of
    // one of these built-in roles) would read them there and delete the
    // backups. So, before step 1, the owner proves that no login but the
    // Database's own user can, that the runtime has run as its own role
    // (the flag and the boot line the API really writes), and that the
    // production bucket's lock rule is the one infra/r2 documents.
    const f1b = subsection(PITR, "F1b");
    const keys = f1b.search(/^1\. Database de produção/m);
    const before = f1b.slice(0, keys);
    const query = commands(before).join("\n");
    const roleCheck = read("src/shared/database/runtime-role-check.ts");
    const productionLock =
      /\|\s*`trajetto-pitr-prod`\s*\|\s*`([^`]+)`\s*\|\s*14\s*\|[^\n]*F1b/.exec(
        read("infra/r2/bucket-locks.md"),
      )?.[1];

    expect(keys).toBeGreaterThan(0);
    expect(Object.keys(envShape())).toContain("DATABASE_REQUIRE_RUNTIME_ROLE");
    expect(before).toContain("`DATABASE_REQUIRE_RUNTIME_ROLE=true`");
    expect(roleCheck).toContain('"database role checked"');
    expect(before).toContain("`database role checked`");
    expect(query).toMatch(/FROM pg_stat_activity/);
    expect(query).toMatch(/FROM pg_roles/);

    for (const power of [
      "rolcanlogin",
      "rolsuper",
      ...SERVER_ROLES.map((role) => `'${role}'`),
    ]) {
      expect(query, power).toContain(power);
    }

    expect(productionLock).toBe("archive/trajetto/1");
    expect(before).toContain(`\`${productionLock}\``);
  });

  it("never tells anyone to fill the Database's Command or Args", () => {
    // The old tuning recipe typed `docker-entrypoint.sh postgres -c …` into
    // the Database's command, which skips the image's wrapper.
    const blocks = [...deploy.matchAll(/^ *```[a-z]*\n([\s\S]*?)^ *```/gm)].map(
      (match) => match[1],
    );

    expect(
      blocks.filter((block) => /docker-entrypoint\.sh postgres/.test(block)),
    ).toEqual([]);
    expect(PITR).toMatch(/_Command_ e _Args_ do Database ficam VAZIOS/);
  });
});

describe("the Database's variables in docs/variaveis-de-ambiente.md", () => {
  it("are all documented in section 14", () => {
    const missing = [...DATABASE_ENV].filter(
      (name) => !DATABASE_VARIABLES.includes(`\`${name}\``),
    );

    expect(DATABASE_ENV.size).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });

  it("include the second repository as a whole", () => {
    expect(entrypoint).toContain("if any_repo_var 2; then");
    expect(DATABASE_VARIABLES).toContain("`PGBACKREST_REPO2_*`");
  });
});

/** The text of the first code span of a cell. */
const code = (cell: string) => /`([^`]+)`/.exec(cell)?.[1] ?? "";

/** The "Valores por ambiente" table: its columns and a row by its label. */
function valuesTable() {
  const part = PITR.split(/^(?=### )/m).find((chunk) =>
    chunk.startsWith("### Valores por ambiente"),
  );
  const rows = (part ?? "")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const [header, , ...body] = rows;

  return {
    columns: header.slice(1),
    row(label: string): string[] {
      const found = body.filter((cells) => cells[0] === label);

      expect(found, label).toHaveLength(1);

      return found[0].slice(1);
    },
  };
}

const bash = hasShell("bash");

describe.skipIf(!bash)("the table of values, through the wrapper", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub(
      "docker-entrypoint.sh",
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${box.root}/argv"`,
    );
  });

  afterEach(() => box.dispose());

  /** What the wrapper hands Postgres, from one column of the table. */
  function start(env: Record<string, string>) {
    const clean = Object.fromEntries(
      [...DATABASE_ENV, "APP_COMMIT_SHA"].map((name) => [name, ""]),
    );
    const result = run(
      "bash",
      repoFile("infra/postgres/trajetto-entrypoint.sh"),
      ["postgres"],
      {
        bin: box.bin,
        env: {
          ...clean,
          PGDATA: "/var/lib/postgresql/data",
          POSTGRES_USER: "trajetto",
          TRAJETTO_POSTGRES_PARAMS: repoFile("infra/postgres/postgres.params"),
          TRAJETTO_PGBACKREST_CONF_DIR: `${box.root}/conf.d`,
          TRAJETTO_CGROUP_ROOT: `${box.root}/cgroup`,
          ...env,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);

    const argv = readFileSync(`${box.root}/argv`, "utf8").split("\n");
    const settings = new Map<string, string>();

    for (let at = 0; at < argv.length; at++) {
      if (argv[at] === "-c") {
        const [name, ...value] = argv[at + 1].split("=");
        settings.set(name, value.join("="));
      }
    }

    const runtime = `${box.root}/conf.d/runtime.conf`;

    return {
      settings,
      runtimeConf: existsSync(runtime) ? readFileSync(runtime, "utf8") : "",
    };
  }

  const table = valuesTable();
  const SIZES = [
    "`POSTGRES_MEMORY_LIMIT_MB`",
    "`POSTGRES_MAX_WAL_SIZE`",
    "`POSTGRES_MAX_SLOT_WAL_KEEP_SIZE`",
    "`PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX`",
  ];

  it.each(table.columns.map((column, index) => [column, index] as const))(
    "%s",
    (_column, index) => {
      const env: Record<string, string> = {};

      for (const label of SIZES) {
        const value = code(table.row(label)[index]);

        if (value) env[label.replace(/`/g, "")] = value;
      }

      const archiving = code(table.row("`PITR_ARCHIVE`")[index]) === "on";
      const bucket = code(table.row("`PGBACKREST_REPO1_S3_BUCKET`")[index]);
      // A complete repo1 where the column has one; the secrets are dummies.
      const repo: Record<string, string> = bucket
        ? {
            PGBACKREST_REPO1_S3_ENDPOINT: "account.r2.example.com",
            PGBACKREST_REPO1_S3_BUCKET: bucket,
            PGBACKREST_REPO1_S3_KEY: "key",
            PGBACKREST_REPO1_S3_KEY_SECRET: "secret",
            PGBACKREST_REPO1_CIPHER_PASS: "pass",
          }
        : {};

      const shown = (label: string) =>
        [...table.row(label)[index].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const sharedBuffers = shown("`SHOW shared_buffers` esperado");
      const archiveMode = shown("`SHOW archive_mode` esperado");

      // Before PITR_ARCHIVE (the F1a's steps 4 to 6, the swap, the F1b's
      // step 1), then with it, where the column turns it on.
      const before = start({ ...env, ...repo });

      expect(before.settings.get("shared_buffers")).toBe(sharedBuffers[0]);
      // Without PITR_ARCHIVE the wrapper always writes off; a column that
      // turns it on may state only the end state.
      expect(before.settings.get("archive_mode")).toBe(
        archiving ? "off" : archiveMode[0],
      );
      expect(before.settings.get("max_wal_size")).toBe(
        env.POSTGRES_MAX_WAL_SIZE,
      );
      expect(before.settings.get("max_slot_wal_keep_size")).toBe(
        env.POSTGRES_MAX_SLOT_WAL_KEEP_SIZE ?? "4GB",
      );

      if (bucket) {
        // stanza-create runs before PITR_ARCHIVE=on: the runtime.conf with
        // the queue cap is already there.
        expect(before.runtimeConf).toContain(
          `archive-push-queue-max=${env.PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX}`,
        );
      }

      if (archiving) {
        const after = start({ ...env, ...repo, PITR_ARCHIVE: "on" });

        expect(after.settings.get("archive_mode")).toBe(
          archiveMode[archiveMode.length - 1],
        );
        expect(after.settings.get("archive_mode")).toBe("on");
      }
    },
  );
});
