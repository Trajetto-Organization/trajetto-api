import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The trajetto-postgres image (plano-escala F1-01), without Docker.
 *
 * The Database of staging and production is about to run this image on the
 * volume today's postgres:16-alpine wrote, with every parameter production
 * runs versioned in it instead of typed into the Dokploy panel. What can go
 * wrong is quiet and expensive: another base under a physical copy of the
 * cluster corrupts its text indexes; a fixed maintenance_work_mem of 1 GiB
 * with five autovacuum workers blows a 768 MiB cap and one killed backend
 * takes the cluster into crash recovery; an archive_command switched on
 * without a repository fills the pg_wal both productions share; a Command
 * typed into the Database replaces the wrapper and nothing complains.
 *
 * Here the files are read and trajetto-entrypoint.sh runs for real, with
 * the official entrypoint stubbed: the flags it hands to Postgres are what
 * is asserted. `docker build --target test infra/postgres` (the Postgres
 * image job of validate.yml) starts the real server with them and reads
 * each value back with SHOW.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const dockerfile = read("infra/postgres/Dockerfile");
const params = read("infra/postgres/postgres.params");
const pgbackrestConf = read("infra/postgres/pgbackrest.conf");

/** The Dockerfile's instructions, continuation lines joined. */
const instructions = dockerfile
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n")
  .replace(/\\\n/g, " ")
  .split("\n")
  .map((line) => line.trim().replace(/\s+/g, " "))
  .filter(Boolean);

/** name=value pairs of postgres.params, comments and blanks dropped. */
const staticParams = params
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);

const paramNames = staticParams.map((line) => line.split("=")[0]);

describe("the image's Dockerfile", () => {
  it("builds on the very postgres:16-alpine digest the E2E services and the smoke test run", () => {
    const from =
      /^FROM (postgres:16-alpine@sha256:[0-9a-f]{64}) AS base$/m.exec(
        instructions.join("\n"),
      );

    expect(from).not.toBeNull();

    const validate = read(".github/workflows/validate.yml");
    const staging = read(".github/workflows/staging.yml");
    const e2e = /image: (postgres:16-alpine@sha256:[0-9a-f]{64})/.exec(
      validate,
    );

    // The base is the database production created its volume with: the
    // same major, the same musl and libc collation. A different digest here
    // than in the suites would test one server and ship another.
    expect(e2e?.[1]).toBe(from?.[1]);
    expect(staging).toContain(`POSTGRES_IMAGE: ${from?.[1]}`);
    // Only the base: every other stage builds on it.
    expect(instructions.filter((line) => /^FROM /.test(line))).toEqual([
      expect.stringMatching(/^FROM postgres:16-alpine@sha256:\w+ AS base$/),
      "FROM base AS pgbackrest",
      "FROM base AS app",
      "FROM app AS test",
      "FROM app AS runtime",
    ]);
  });

  it("declares pgBackRest's version and the source's SHA-256 once, in one ARG before every stage", () => {
    const declared = instructions.filter((line) =>
      /^ARG .*PGBACKREST_(?:VERSION|SHA256)=/.test(line),
    );

    // The primary, the future standby and the drill run this image: one
    // value, so they can never disagree on the version.
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(
      /^ARG PGBACKREST_VERSION=\d+\.\d+\.\d+ PGBACKREST_SHA256=[0-9a-f]{64}$/,
    );
    expect(instructions.indexOf(declared[0])).toBeLessThan(
      instructions.findIndex((line) => /^FROM /.test(line)),
    );
    // The values themselves appear nowhere else.
    const [, version, sha] =
      /PGBACKREST_VERSION=(\S+) PGBACKREST_SHA256=(\S+)/.exec(declared[0]) ??
      [];
    for (const value of [version, sha]) {
      expect(
        instructions.filter((line) => line.includes(value)),
        value,
      ).toHaveLength(1);
    }
    // Every other mention only brings the global into a stage.
    for (const line of instructions.filter(
      (line) => /^ARG /.test(line) && /PGBACKREST/.test(line),
    )) {
      if (line !== declared[0]) expect(line).not.toMatch(/=/);
    }
  });

  it("checks the source's hash before unpacking it, and compiles with no network", () => {
    const build = instructions.slice(
      instructions.indexOf("FROM base AS pgbackrest"),
      instructions.indexOf("FROM base AS app"),
    );
    const download = build.find((line) => /wget/.test(line)) ?? "";
    const compile = build.find((line) => /meson setup/.test(line)) ?? "";

    expect(download).toMatch(/sha256sum -c -.*tar -xzf/);
    expect(download).toContain(
      "https://github.com/pgbackrest/pgbackrest/archive/refs/tags/release/${PGBACKREST_VERSION}.tar.gz",
    );
    expect(compile).toMatch(/^RUN --network=none /);
    expect(compile).toContain(
      'pgbackrest version)" = "pgBackRest ${PGBACKREST_VERSION}"',
    );
  });

  it("ships no postgresql package and fails the build if adding pgBackRest's library moves a package of the base", () => {
    const app = instructions.slice(
      instructions.indexOf("FROM base AS app"),
      instructions.indexOf("FROM app AS test"),
    );
    const adds = instructions.filter((line) => /apk add/.test(line));

    // The pgbackrest package would bring postgresql18, a second server.
    for (const line of adds) {
      expect(line).not.toMatch(/\bpgbackrest\b|\bpostgresql|\blibpq\b/);
    }
    const runtimeAdd = app.find((line) => /apk add/.test(line)) ?? "";
    expect(runtimeAdd).toContain("apk add --no-cache libbz2;");
    expect(runtimeAdd).toMatch(/comm -23 \/tmp\/apk-before \/tmp\/apk-after/);
    expect(runtimeAdd).toContain("exit 1");
    // Only the binary crosses from the builder.
    expect(app).toContain("COPY --link --from=pgbackrest /out/ /");
  });

  it("runs the wrapper as the entrypoint, the tests offline, and builds the image last", () => {
    expect(instructions).toContain('ENTRYPOINT ["trajetto-entrypoint.sh"]');
    expect(instructions).toContain('CMD ["postgres"]');
    expect(instructions).toContain(
      'RUN --network=none PGBACKREST_VERSION="${PGBACKREST_VERSION}" bash /usr/local/lib/trajetto-test/run.sh',
    );
    // No HEALTHCHECK: Swarm would kill a server still in crash recovery.
    expect(instructions.some((line) => /^HEALTHCHECK/.test(line))).toBe(false);
  });

  it("keeps its files LF on any checkout: a CRLF params file or script breaks the container", () => {
    expect(read(".gitattributes")).toMatch(
      /^infra\/postgres\/\*\* text eol=lf$/m,
    );
  });
});

describe("the image's test stage", () => {
  const test = read("infra/postgres/test/run.sh");

  it("reads back every row of the memory table with SHOW", () => {
    for (const [limit, sb, ecs, mwm, avwm, wm] of MEMORY_TABLE) {
      expect(test).toContain(
        `${limit} ${sb} ${ecs} ${mwm} ${avwm} ${wm} ${limit < 2048 ? 3 : 5}`,
      );
    }
  });

  it("proves the PITR round trip and the queue cap, not just the start", () => {
    expect(test).toContain("pgbr stanza-create");
    expect(test).toContain("pgbr backup --type=full");
    expect(test).toContain('pgbr archive-get "$segment"');
    expect(test).toMatch(/--type=time "--target=\$\{target\}"/);
    expect(test).toContain("--archive-mode=off restore");
    expect(test).toContain('[ "$rows" = "first:100" ]');
    expect(test).toContain("PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX=1MB");
    expect(test).toContain('grep -q "dropped WAL file"');
  });
});

describe("postgres.params", () => {
  it("is plain name=value lines, as the wrapper reads them", () => {
    expect(staticParams.length).toBeGreaterThan(10);

    for (const line of staticParams) {
      expect(line).toMatch(/^[a-z_][a-z0-9_.]*=\S+$/);
    }
    expect(new Set(paramNames).size).toBe(paramNames.length);
  });

  it("leaves archiving, memory, connections, WAL size and commit grouping to the entrypoint", () => {
    // archive_* only through PITR_ARCHIVE=on and a complete repository.
    expect(paramNames.filter((name) => name.startsWith("archive"))).toEqual([]);

    for (const derived of [
      "shared_buffers",
      "effective_cache_size",
      "work_mem",
      "maintenance_work_mem",
      "autovacuum_work_mem",
      "autovacuum_max_workers",
      "max_connections",
      "max_wal_size",
      "max_slot_wal_keep_size",
      "commit_delay",
      "commit_siblings",
      // A 2xx means committed (plano-escala P6).
      "synchronous_commit",
      "fsync",
      "full_page_writes",
    ]) {
      expect(paramNames, derived).not.toContain(derived);
    }
  });

  it("preloads pg_stat_statements alone: auto_explain prints the plans' constants", () => {
    expect(staticParams).toContain(
      "shared_preload_libraries=pg_stat_statements",
    );
    expect(params).not.toMatch(/^[^#]*auto_explain/m);
  });

  it("keeps the plan's static parameters", () => {
    for (const line of [
      "log_parameter_max_length=0",
      "pg_stat_statements.track_utility=off",
      "jit=off",
      "max_parallel_workers_per_gather=0",
      "max_parallel_maintenance_workers=0",
      "hash_mem_multiplier=2",
      "compute_query_id=on",
      "wal_level=replica",
    ]) {
      expect(staticParams).toContain(line);
    }
  });
});

describe("pgbackrest.conf", () => {
  const settings = pgbackrestConf
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.includes("="));

  it("carries no secret: the keys and the passphrase come from the Database's environment", () => {
    for (const line of settings) {
      expect(line).not.toMatch(/(?:-key|key-secret|cipher-pass|token)\s*=/);
    }
  });

  it("points repo1 at R2's S3 API, encrypted, at the bucket's root", () => {
    for (const line of [
      "repo1-type=s3",
      "repo1-s3-region=auto",
      "repo1-s3-uri-style=path",
      "repo1-path=/",
      "repo1-cipher-type=aes-256-cbc",
      "repo1-retention-full-type=time",
      "repo1-retention-full=30",
      "compress-type=zst",
    ]) {
      expect(settings).toContain(line);
    }
  });

  it("leaves repo2 to the environment, whole", () => {
    expect(settings.filter((line) => line.startsWith("repo2-"))).toEqual([]);
  });

  it("writes no log file inside the container", () => {
    expect(settings).toContain("log-level-file=off");
  });
});

/**
 * limit → shared_buffers / effective_cache_size / maintenance_work_mem /
 * autovacuum_work_mem / work_mem, in MB (plano-escala F1-01), with the
 * default 20 expected active connections.
 */
const MEMORY_TABLE = [
  [576, 108, 302, 54, 27, 4],
  [768, 144, 403, 72, 36, 4],
  [1792, 384, 1075, 192, 96, 11],
  [2048, 448, 1254, 224, 112, 13],
  [3072, 704, 1971, 352, 176, 21],
  [12288, 3008, 8422, 1024, 256, 64],
] as const;

const bash = hasShell("bash");

/** Every variable the wrapper reads, absent unless a test sets it. */
const CLEAN_ENV: Record<string, string> = Object.fromEntries(
  [
    "POSTGRES_MEMORY_LIMIT_MB",
    "POSTGRES_EXPECTED_ACTIVE_CONNECTIONS",
    "POSTGRES_MAX_CONNECTIONS",
    "POSTGRES_MAX_WAL_SIZE",
    "POSTGRES_MAX_SLOT_WAL_KEEP_SIZE",
    "POSTGRES_COMMIT_DELAY_US",
    "POSTGRES_COMMIT_SIBLINGS",
    "POSTGRES_AUTO_EXPLAIN",
    "PITR_ARCHIVE",
    "APP_COMMIT_SHA",
    "PGBACKREST_REPO1_TYPE",
    "PGBACKREST_REPO1_PATH",
    "PGBACKREST_REPO1_S3_ENDPOINT",
    "PGBACKREST_REPO1_S3_BUCKET",
    "PGBACKREST_REPO1_S3_KEY",
    "PGBACKREST_REPO1_S3_KEY_SECRET",
    "PGBACKREST_REPO1_CIPHER_PASS",
    "PGBACKREST_REPO1_CIPHER_TYPE",
    "PGBACKREST_REPO2_TYPE",
    "PGBACKREST_REPO2_S3_ENDPOINT",
    "PGBACKREST_REPO2_S3_BUCKET",
    "PGBACKREST_REPO2_S3_KEY",
    "PGBACKREST_REPO2_S3_KEY_SECRET",
    "PGBACKREST_REPO2_CIPHER_PASS",
    "PGBACKREST_REPO2_CIPHER_TYPE",
    "PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX",
  ].map((name) => [name, ""]),
);

/** A complete R2 repo1, with values that must never reach the output. */
const R2 = {
  PGBACKREST_REPO1_S3_ENDPOINT: "account.r2.example.com",
  PGBACKREST_REPO1_S3_BUCKET: "trajetto-pitr-test",
  PGBACKREST_REPO1_S3_KEY: "key-id-never-printed",
  PGBACKREST_REPO1_S3_KEY_SECRET: "key-secret-never-printed",
  PGBACKREST_REPO1_CIPHER_PASS: "cipher-pass-never-printed",
};

const SECRETS = [
  R2.PGBACKREST_REPO1_S3_KEY,
  R2.PGBACKREST_REPO1_S3_KEY_SECRET,
  R2.PGBACKREST_REPO1_CIPHER_PASS,
];

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
  // The official entrypoint: records what the wrapper would start.
  box.stub(
    "docker-entrypoint.sh",
    `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${box.root}/argv"`,
  );
  box.stub("pgbackrest", "exit 0");
});

afterEach(() => box.dispose());

function wrapper(
  env: Record<string, string> = {},
  args: string[] = ["postgres"],
) {
  const result = run(
    "bash",
    repoFile("infra/postgres/trajetto-entrypoint.sh"),
    args,
    {
      bin: box.bin,
      env: {
        ...CLEAN_ENV,
        PGDATA: "/var/lib/postgresql/data",
        POSTGRES_USER: "trajetto",
        TRAJETTO_POSTGRES_PARAMS: repoFile("infra/postgres/postgres.params"),
        TRAJETTO_PGBACKREST_CONF_DIR: `${box.root}/conf.d`,
        // The host's own cgroup never decides a test's numbers.
        TRAJETTO_CGROUP_ROOT: `${box.root}/cgroup`,
        ...env,
      },
    },
  );
  const argvFile = `${box.root}/argv`;
  const argv = existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").split("\n").slice(0, -1)
    : [];
  // The value of every `-c name=value`, the last one of each name winning,
  // as Postgres reads them.
  const settings = new Map<string, string>();
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === "-c") {
      const [name, ...value] = argv[at + 1].split("=");
      settings.set(name, value.join("="));
    }
  }
  const runtimeConfFile = `${box.root}/conf.d/runtime.conf`;
  const runtimeConf = existsSync(runtimeConfFile)
    ? readFileSync(runtimeConfFile, "utf8")
    : null;

  return { ...result, argv, settings, runtimeConf };
}

describe.skipIf(!bash)("trajetto-entrypoint.sh", () => {
  it.each(MEMORY_TABLE)(
    "derives the memory from a %i MiB cap",
    (limit, sb, ecs, mwm, avwm, wm) => {
      const { status, settings, stderr } = wrapper({
        POSTGRES_MEMORY_LIMIT_MB: String(limit),
      });

      expect(status).toBe(0);
      expect(settings.get("shared_buffers")).toBe(`${sb}MB`);
      expect(settings.get("effective_cache_size")).toBe(`${ecs}MB`);
      expect(settings.get("maintenance_work_mem")).toBe(`${mwm}MB`);
      expect(settings.get("autovacuum_work_mem")).toBe(`${avwm}MB`);
      expect(settings.get("work_mem")).toBe(`${wm}MB`);
      expect(settings.get("autovacuum_max_workers")).toBe(
        limit < 2048 ? "3" : "5",
      );
      expect(stderr).toContain(`memória de ${limit} MiB`);
    },
  );

  it("shares work_mem among the expected active connections", () => {
    const { settings } = wrapper({
      POSTGRES_MEMORY_LIMIT_MB: "2048",
      POSTGRES_EXPECTED_ACTIVE_CONNECTIONS: "4",
    });

    // 1792 × 0.30 / (2 × 4) = 67 → the 64 MB ceiling.
    expect(settings.get("work_mem")).toBe("64MB");
  });

  it("leaves the memory at Postgres' defaults without a cap, and says so", () => {
    const { status, settings, stderr } = wrapper();

    expect(status).toBe(0);
    for (const name of [
      "shared_buffers",
      "effective_cache_size",
      "work_mem",
      "maintenance_work_mem",
      "autovacuum_work_mem",
      "autovacuum_max_workers",
    ]) {
      expect(settings.has(name), name).toBe(false);
    }
    expect(stderr).toContain("sem POSTGRES_MEMORY_LIMIT_MB");
  });

  it("counts from the container's own cap when the variable asks for more", () => {
    box.file("cgroup/memory.max", `${576 * 1048576}\n`);

    const { status, settings, stderr } = wrapper({
      POSTGRES_MEMORY_LIMIT_MB: "2048",
    });

    expect(status).toBe(0);
    expect(settings.get("shared_buffers")).toBe("108MB");
    expect(stderr).toMatch(
      /AVISO: POSTGRES_MEMORY_LIMIT_MB=2048 passa do Memory Limit do contêiner \(576 MiB\)/,
    );
  });

  it("starts the static parameters first and the defaults of the rest", () => {
    const { argv, settings } = wrapper();

    expect(argv[0]).toBe("postgres");
    expect(argv.slice(1, 1 + staticParams.length * 2)).toEqual(
      staticParams.flatMap((line) => ["-c", line]),
    );
    expect(settings.get("max_connections")).toBe("200");
    expect(settings.get("max_wal_size")).toBe("8GB");
    expect(settings.get("max_slot_wal_keep_size")).toBe("4GB");
    expect(settings.get("commit_delay")).toBe("0");
    expect(settings.get("commit_siblings")).toBe("5");
    expect(settings.get("trajetto.image_revision")).toBe("dev");
    expect(settings.has("synchronous_commit")).toBe(false);
  });

  it("takes connections, WAL size, the slot cap and commit grouping from the environment", () => {
    const { settings } = wrapper({
      POSTGRES_MAX_CONNECTIONS: "120",
      POSTGRES_MAX_WAL_SIZE: "1GB",
      POSTGRES_MAX_SLOT_WAL_KEEP_SIZE: "2GB",
      POSTGRES_COMMIT_DELAY_US: "200",
      POSTGRES_COMMIT_SIBLINGS: "8",
      APP_COMMIT_SHA: "0123abcd",
    });

    expect(settings.get("max_connections")).toBe("120");
    expect(settings.get("max_wal_size")).toBe("1GB");
    expect(settings.get("max_slot_wal_keep_size")).toBe("2GB");
    expect(settings.get("commit_delay")).toBe("200");
    expect(settings.get("commit_siblings")).toBe("8");
    expect(settings.get("trajetto.image_revision")).toBe("0123abcd");
  });

  it("falls back on bad values with a warning, and still starts the server", () => {
    const { status, settings, stderr } = wrapper({
      POSTGRES_MEMORY_LIMIT_MB: "2G",
      POSTGRES_EXPECTED_ACTIVE_CONNECTIONS: "0",
      POSTGRES_MAX_CONNECTIONS: "lots",
      POSTGRES_MAX_WAL_SIZE: "1 GB",
      POSTGRES_COMMIT_DELAY_US: "-5",
      POSTGRES_COMMIT_SIBLINGS: "x",
      APP_COMMIT_SHA: "not a commit;",
    });

    expect(status).toBe(0);
    expect(settings.has("shared_buffers")).toBe(false);
    expect(settings.get("max_connections")).toBe("200");
    expect(settings.get("max_wal_size")).toBe("8GB");
    expect(settings.get("commit_delay")).toBe("0");
    expect(settings.get("commit_siblings")).toBe("5");
    expect(settings.get("trajetto.image_revision")).toBe("dev");
    expect(stderr.match(/AVISO/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("never lets a replication slot keep unlimited WAL", () => {
    const { settings, stderr } = wrapper({
      POSTGRES_MAX_SLOT_WAL_KEEP_SIZE: "-1",
    });

    expect(settings.get("max_slot_wal_keep_size")).toBe("4GB");
    expect(stderr).toContain("POSTGRES_MAX_SLOT_WAL_KEEP_SIZE='-1'");
  });

  it("adds auto_explain only on request", () => {
    expect(wrapper().settings.get("shared_preload_libraries")).toBe(
      "pg_stat_statements",
    );

    const { settings, stderr } = wrapper({ POSTGRES_AUTO_EXPLAIN: "on" });

    expect(settings.get("shared_preload_libraries")).toBe(
      "pg_stat_statements,auto_explain",
    );
    expect(settings.get("auto_explain.log_min_duration")).toBe("2s");
    expect(stderr).toContain("POSTGRES_AUTO_EXPLAIN=on");
  });

  describe("archiving", () => {
    it("is explicitly off without PITR_ARCHIVE, even with the repository complete", () => {
      const { settings, runtimeConf } = wrapper({ ...R2 });

      expect(settings.get("archive_mode")).toBe("off");
      expect(settings.has("archive_command")).toBe(false);
      // stanza-create runs before archiving is switched on.
      expect(runtimeConf).not.toBeNull();
    });

    it("is on only with PITR_ARCHIVE=on and a complete repo1", () => {
      const { settings, stderr } = wrapper({ ...R2, PITR_ARCHIVE: "on" });

      expect(settings.get("archive_mode")).toBe("on");
      expect(settings.get("archive_command")).toBe(
        "pgbackrest --stanza=trajetto archive-push %p",
      );
      expect(settings.get("archive_timeout")).toBe("60s");
      expect(stderr).toContain("arquivamento ligado");
    });

    it.each([
      "PGBACKREST_REPO1_S3_ENDPOINT",
      "PGBACKREST_REPO1_S3_BUCKET",
      "PGBACKREST_REPO1_S3_KEY",
      "PGBACKREST_REPO1_S3_KEY_SECRET",
      "PGBACKREST_REPO1_CIPHER_PASS",
    ])("stays off without %s, naming it and printing no value", (missing) => {
      const { status, settings, stderr, stdout, runtimeConf } = wrapper({
        ...R2,
        [missing]: "",
        PITR_ARCHIVE: "on",
      });

      expect(status).toBe(0);
      expect(settings.get("archive_mode")).toBe("off");
      expect(stderr).toContain(missing);
      expect(stderr).toContain("arquivamento DESLIGADO");
      expect(runtimeConf).toBeNull();
      for (const secret of SECRETS) {
        expect(stderr + stdout).not.toContain(secret);
      }
    });

    it("refuses an unencrypted repository", () => {
      const { settings, stderr } = wrapper({
        ...R2,
        PGBACKREST_REPO1_CIPHER_TYPE: "none",
        PITR_ARCHIVE: "on",
      });

      expect(settings.get("archive_mode")).toBe("off");
      expect(stderr).toContain("PGBACKREST_REPO1_CIPHER_TYPE(none não vale)");
    });

    it("reads a posix repository too (the image's own test stage)", () => {
      const { settings } = wrapper({
        PGBACKREST_REPO1_TYPE: "posix",
        PGBACKREST_REPO1_PATH: "/tmp/repo",
        PGBACKREST_REPO1_CIPHER_PASS: "cipher-pass-never-printed",
        PITR_ARCHIVE: "on",
      });

      expect(settings.get("archive_mode")).toBe("on");
    });

    it("does not take anything but 'on' as on", () => {
      const { settings, stderr } = wrapper({ ...R2, PITR_ARCHIVE: "true" });

      expect(settings.get("archive_mode")).toBe("off");
      expect(stderr).toContain("PITR_ARCHIVE='true' não é 'on'");
    });

    it("writes runtime.conf with the user, the data path and the queue cap, never a secret", () => {
      const { runtimeConf } = wrapper({
        ...R2,
        PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX: "1GB",
      });

      expect(runtimeConf).toContain("archive-push-queue-max=1GB\n");
      expect(runtimeConf).toContain("process-max=1\n");
      expect(runtimeConf).toContain("buffer-size=1MiB\n");
      expect(runtimeConf).toContain("pg1-path=/var/lib/postgresql/data\n");
      expect(runtimeConf).toContain("pg1-user=trajetto\n");
      for (const secret of SECRETS) expect(runtimeConf).not.toContain(secret);
    });

    it("caps the archive queue at 4GB by default, and refuses a value pgBackRest would not read", () => {
      expect(wrapper({ ...R2 }).runtimeConf).toContain(
        "archive-push-queue-max=4GB\n",
      );

      const { runtimeConf, stderr } = wrapper({
        ...R2,
        PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX: "unlimited",
      });

      expect(runtimeConf).toContain("archive-push-queue-max=4GB\n");
      expect(stderr).toContain("PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX='unlimited'");
    });

    it("removes a stale runtime.conf once the repository is gone", () => {
      box.file("conf.d/runtime.conf", "[global]\nstale=1\n");

      expect(wrapper().runtimeConf).toBeNull();
    });

    it("warns about an incomplete repo2, which would fail every archive-push", () => {
      const { settings, stderr } = wrapper({
        ...R2,
        PITR_ARCHIVE: "on",
        PGBACKREST_REPO2_TYPE: "s3",
        PGBACKREST_REPO2_S3_BUCKET: "trajetto-pitr-second",
      });

      expect(settings.get("archive_mode")).toBe("on");
      expect(stderr).toMatch(
        /repo2 do pgBackRest incompleto, faltam: .*PGBACKREST_REPO2_S3_ENDPOINT/,
      );
      expect(stderr).toContain("PGBACKREST_REPO2_CIPHER_TYPE");
    });
  });

  describe("the container's own arguments", () => {
    it("come last, so an extra flag wins and every other stays", () => {
      const { argv, settings } = wrapper({ POSTGRES_MEMORY_LIMIT_MB: "576" }, [
        "postgres",
        "-c",
        "work_mem=7MB",
      ]);

      expect(argv.slice(-2)).toEqual(["-c", "work_mem=7MB"]);
      expect(settings.get("work_mem")).toBe("7MB");
      expect(settings.get("shared_buffers")).toBe("108MB");
      expect(settings.get("archive_mode")).toBe("off");
    });

    it("may be flags alone, as the Database's Args arrive", () => {
      const { argv, settings } = wrapper({}, ["-c", "jit=on"]);

      expect(argv[0]).toBe("postgres");
      expect(argv.filter((arg) => arg === "postgres")).toHaveLength(1);
      expect(settings.get("jit")).toBe("on");
      expect(settings.get("hash_mem_multiplier")).toBe("2");
    });

    it("run any other command as given, with nothing added", () => {
      const { status } = wrapper({}, ["pgbackrest", "info"]);

      expect(status).toBe(0);
      expect(box.calls("pgbackrest")).toEqual(["pgbackrest info"]);
      expect(box.calls("docker-entrypoint.sh")).toEqual([]);
    });
  });

  it("refuses to start from a broken params file: a build defect, never silently dropped", () => {
    const broken = box.file("broken.params", "jit=off\nwork mem = 4MB\n");

    const { status, stderr } = wrapper({ TRAJETTO_POSTGRES_PARAMS: broken });

    expect(status).toBe(64);
    expect(stderr).toContain("broken.params:2 não é nome=valor");
    expect(box.calls("docker-entrypoint.sh")).toEqual([]);
  });
});
