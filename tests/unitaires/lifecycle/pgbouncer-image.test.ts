import { existsSync, readFileSync, statSync } from "node:fs";
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
 * The trajetto-pgbouncer image (plano-escala F4-34), without Docker.
 *
 * From wave 17 on, every Application reaches the Database through this
 * image, and the failover retargets it alone. What can go wrong is quiet:
 * a PgBouncer below 1.26.1 spins forever on one startup packet with this
 * very configuration (CVE-2026-107349); a session pool holds one
 * Postgres connection per client, and the budget of 60 is gone with the
 * first deploy; an admin console reachable from the network turns one
 * leaked password into a PAUSE of every database; a HEALTHCHECK that
 * touches Postgres makes Swarm kill the endpoint of every Application
 * while the Database restarts; a password left in PgBouncer's process
 * environment or printed in its log reaches whoever reads them.
 *
 * Here the Dockerfile is read and entrypoint.sh runs for real, with the
 * pgbouncer binary stubbed: the files it writes are what is asserted.
 * `docker build --target test infra/pgbouncer` (infra/pgbouncer/test/run.sh)
 * starts the real PgBouncer from them and reads every value back from its
 * console; the E2E's infra phase (F4-38) puts a real Postgres behind it.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const dockerfile = read("infra/pgbouncer/Dockerfile");
const testScript = read("infra/pgbouncer/test/run.sh");

/** The Dockerfile's instructions, continuation lines joined. */
const instructions = dockerfile
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n")
  .replace(/\\\n/g, " ")
  .split("\n")
  .map((line) => line.trim().replace(/\s+/g, " "))
  .filter(Boolean);

/** The instructions of one stage, from its FROM to the next. */
function stage(name: string): string[] {
  const start = instructions.findIndex((line) =>
    new RegExp(`^FROM \\S+ AS ${name}$`).test(line),
  );
  const next = instructions.findIndex(
    (line, at) => at > start && /^FROM /.test(line),
  );

  return instructions.slice(start, next === -1 ? undefined : next);
}

const versionAtLeast = (version: string, floor: string) => {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let at = 0; at < 3; at++) {
    if (a[at] !== b[at]) return a[at] > b[at];
  }
  return true;
};

describe("the image's Dockerfile", () => {
  it("builds on Alpine by digest, in the stages of the other images, the image last", () => {
    expect(instructions.filter((line) => /^FROM /.test(line))).toEqual([
      expect.stringMatching(
        /^FROM alpine:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} AS base$/,
      ),
      "FROM base AS build",
      "FROM base AS app",
      "FROM app AS test",
      "FROM app AS runtime",
    ]);
  });

  it("declares PgBouncer's version, 1.26.1 or newer, and the source's SHA-256 once, before every stage", () => {
    const declared = instructions.filter((line) =>
      /^ARG .*PGBOUNCER_(?:VERSION|SHA256)=/.test(line),
    );

    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(
      /^ARG PGBOUNCER_VERSION=\d+\.\d+\.\d+ PGBOUNCER_SHA256=[0-9a-f]{64}$/,
    );
    expect(instructions.indexOf(declared[0])).toBeLessThan(
      instructions.findIndex((line) => /^FROM /.test(line)),
    );

    const [, version, sha] =
      /PGBOUNCER_VERSION=(\S+) PGBOUNCER_SHA256=(\S+)/.exec(declared[0]) ?? [];

    // 1.26.1 fixes the spin on an empty option name (CVE-2026-107349),
    // reachable before login with ignore_startup_parameters set without
    // `options`, as here, and the SCRAM impersonation by a second
    // StartupMessage (CVE-2026-107350), reachable with any auth_file login.
    expect(versionAtLeast(version, "1.26.1"), version).toBe(true);
    for (const value of [version, sha]) {
      expect(
        instructions.filter((line) => line.includes(value)),
        value,
      ).toHaveLength(1);
    }
    for (const line of instructions.filter(
      (line) => /^ARG /.test(line) && /PGBOUNCER/.test(line),
    )) {
      if (line !== declared[0]) expect(line).not.toMatch(/=/);
    }
  });

  it("checks the source's hash before unpacking it, and compiles with no network", () => {
    const build = stage("build");
    const fetch = build.find((line) => line.includes("sha256sum -c")) ?? "";

    expect(fetch).toContain(
      "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz",
    );
    expect(fetch.indexOf("sha256sum -c")).toBeLessThan(fetch.indexOf("tar "));

    const compile = build.find((line) => line.includes("./configure")) ?? "";

    expect(compile).toMatch(/^RUN --network=none /);
    expect(compile).toContain("--with-cares");
    expect(compile).toContain(
      'test "$(/out/usr/local/bin/pgbouncer --version | head -n 1)" = "PgBouncer ${PGBOUNCER_VERSION}"',
    );
    // Only the binary leaves the build stage.
    expect(stage("app")).toContain("COPY --link --from=build /out/ /");
  });

  it("runs as its own unprivileged user, owner of the only directory with the passwords", () => {
    const app = stage("app");
    const user = app.indexOf("USER pgbouncer");

    expect(user).toBeGreaterThan(-1);
    expect(app.join("\n")).toContain(
      "install -d -o pgbouncer -g pgbouncer -m 0700 /etc/pgbouncer",
    );
    // Nothing after it switches back, and every stage after app inherits it.
    expect(instructions.filter((line) => /^USER /.test(line))).toEqual([
      "USER pgbouncer",
    ]);
    expect(app.findIndex((line) => /^ENTRYPOINT /.test(line))).toBeGreaterThan(
      user,
    );
  });

  it("checks PgBouncer itself on the local port, never the Database, with the command the test stage runs", () => {
    const healthcheck = instructions.find((line) => /^HEALTHCHECK /.test(line));
    const command = /CMD (\[.*\])$/.exec(healthcheck ?? "")?.[1] ?? "[]";
    const argv = JSON.parse(command) as string[];

    // The console database: it answers while Postgres restarts under PAUSE
    // or in a failover, and Swarm must not kill the endpoint every
    // Application points at because the Database is down.
    expect(argv).toEqual([
      "pg_isready",
      "-q",
      "-h",
      "127.0.0.1",
      "-p",
      "6432",
      "-d",
      "pgbouncer",
      "-U",
      "pgbouncer_stats",
      "-t",
      "3",
    ]);
    expect(testScript).toContain(`HEALTHCHECK='${argv.join(" ")}'`);
  });

  it("runs the entrypoint, the tests offline, and builds the image last", () => {
    expect(instructions).toContain(
      'ENTRYPOINT ["trajetto-pgbouncer-entrypoint.sh"]',
    );
    expect(instructions).toContain('CMD ["pgbouncer"]');
    expect(instructions).toContain(
      "COPY --link --chmod=0755 entrypoint.sh /usr/local/bin/trajetto-pgbouncer-entrypoint.sh",
    );
    expect(stage("test")).toContain(
      'RUN --network=none PGBOUNCER_VERSION="${PGBOUNCER_VERSION}" sh /usr/local/lib/trajetto-test/run.sh',
    );
  });

  it("keeps its files LF on any checkout: a CRLF script breaks the container", () => {
    expect(read(".gitattributes")).toMatch(
      /^infra\/pgbouncer\/\*\* text eol=lf$/m,
    );
  });

  it("is in Dependabot's Docker directories: the base moves only when the tree does", () => {
    const config = read(".github/dependabot.yml");
    const docker = config.slice(
      config.indexOf("package-ecosystem: docker\n"),
      config.indexOf("package-ecosystem: pip"),
    );

    expect(docker).toMatch(/^\s+- "\/infra\/pgbouncer"$/m);
  });
});

describe("the image's test stage", () => {
  // The plan's values, read back from the running PgBouncer (SHOW CONFIG).
  it.each([
    "pool_mode transaction",
    "auth_type hba",
    "auth_user pgbouncer_auth",
    "auth_query SELECT * FROM pgbouncer.user_lookup($1)",
    "max_client_conn 2000",
    "default_pool_size 20",
    "max_db_connections 60",
    "query_wait_timeout 5",
    "server_lifetime 3600",
    "ignore_startup_parameters extra_float_digits",
  ])("reads back %s", (line) => {
    expect(testScript.split("\n")).toContain(line);
  });

  it("proves the minimal start, the closed consoles, the silent HEALTHCHECK and the refusal", () => {
    for (const text of [
      "start PGBOUNCER_PRIMARY_HOST=primary.invalid PGBOUNCER_AUTH_PASSWORD=",
      "o HEALTHCHECK deixou erro no log",
      "o console de administração abriu sem PGBOUNCER_ADMIN_PASSWORD",
      "sem PGBOUNCER_PRIMARY_HOST saiu com $status, esperado 64",
      "o login de estatística pausou um banco",
    ]) {
      expect(testScript, text).toContain(text);
    }
  });
});

const sh = hasShell("sh");

/** Every variable the entrypoint reads, absent unless a test sets it. */
const CLEAN_ENV: Record<string, string> = Object.fromEntries(
  [
    "PGBOUNCER_DATABASE",
    "PGBOUNCER_PRIMARY_HOST",
    "PGBOUNCER_PRIMARY_PORT",
    "PGBOUNCER_AUTH_PASSWORD",
    "PGBOUNCER_ADMIN_PASSWORD",
    "PGBOUNCER_STATS_PASSWORD",
    "PGBOUNCER_MAX_CLIENT_CONN",
    "PGBOUNCER_DEFAULT_POOL_SIZE",
    "PGBOUNCER_MAX_DB_CONNECTIONS",
    "APP_COMMIT_SHA",
  ].map((name) => [name, ""]),
);

/** Values that must never reach the output. */
const AUTH = "auth-password-never-printed";
const ADMIN = "admin-password-never-printed";
const STATS = "stats-password-never-printed";
const MINIMAL = {
  PGBOUNCER_PRIMARY_HOST: "trajetto-postgres-staging",
  PGBOUNCER_AUTH_PASSWORD: AUTH,
};

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
  // PgBouncer itself: records what the entrypoint would start, and with
  // which environment.
  box.stub(
    "pgbouncer",
    [
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${box.root}/argv"`,
      `env > "${box.root}/env"`,
    ].join("\n"),
  );
  box.stub("psql", "exit 0");
});

afterEach(() => box.dispose());

function entrypoint(
  env: Record<string, string> = {},
  args: string[] = ["pgbouncer"],
) {
  const conf = `${box.root}/conf`;
  const result = run("sh", repoFile("infra/pgbouncer/entrypoint.sh"), args, {
    bin: box.bin,
    env: {
      ...CLEAN_ENV,
      TRAJETTO_PGBOUNCER_CONF_DIR: conf,
      ...env,
    },
  });
  const file = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : null;
  const argvText = file(`${box.root}/argv`);

  return {
    ...result,
    conf,
    argv: argvText === null ? null : argvText.split("\n").slice(0, -1),
    env: file(`${box.root}/env`),
    ini: file(`${conf}/pgbouncer.ini`),
    userlist: file(`${conf}/userlist.txt`),
    hba: file(`${conf}/pg_hba.conf`),
  };
}

/** The pgbouncer.ini the plan asks for, with the given values. */
function expectedIni(
  conf: string,
  {
    database = "trajetto",
    host = "trajetto-postgres-staging",
    port = "5432",
    maxClientConn = "2000",
    defaultPoolSize = "20",
    maxDbConnections = "60",
    admin = "",
  } = {},
) {
  return [
    "; Written by trajetto-pgbouncer-entrypoint.sh at every start, from the",
    "; environment: an edit here is lost on the next start.",
    "",
    "[databases]",
    `${database} = host=${host} port=${port} dbname=${database}`,
    `${database}_probe = host=${host} port=${port} dbname=${database} pool_size=2 max_db_connections=2`,
    "",
    "[pgbouncer]",
    "listen_addr = 0.0.0.0",
    "listen_port = 6432",
    "unix_socket_dir =",
    "pool_mode = transaction",
    `max_client_conn = ${maxClientConn}`,
    `default_pool_size = ${defaultPoolSize}`,
    `max_db_connections = ${maxDbConnections}`,
    "query_wait_timeout = 5",
    "server_lifetime = 3600",
    "ignore_startup_parameters = extra_float_digits",
    "auth_type = hba",
    `auth_hba_file = ${conf}/pg_hba.conf`,
    `auth_file = ${conf}/userlist.txt`,
    "auth_user = pgbouncer_auth",
    "auth_query = SELECT * FROM pgbouncer.user_lookup($1)",
    `admin_users = ${admin}`,
    "stats_users = pgbouncer_stats",
    "log_connections = 0",
    "log_disconnections = 0",
    "log_pooler_errors = 1",
    "",
  ].join("\n");
}

describe.skipIf(!sh)("entrypoint.sh", () => {
  it("starts with the minimal environment and writes the expected pgbouncer.ini", () => {
    const result = entrypoint(MINIMAL);

    expect(result.status, result.stderr).toBe(0);
    expect(result.ini).toBe(expectedIni(result.conf));
    expect(result.argv).toEqual([`${result.conf}/pgbouncer.ini`]);
  });

  it("names the database and the primary from the environment", () => {
    const result = entrypoint({
      ...MINIMAL,
      PGBOUNCER_DATABASE: "trajetto_ci",
      PGBOUNCER_PRIMARY_HOST: "10.0.1.15",
      PGBOUNCER_PRIMARY_PORT: "5433",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.ini).toBe(
      expectedIni(result.conf, {
        database: "trajetto_ci",
        host: "10.0.1.15",
        port: "5433",
      }),
    );
    expect(result.hba).toContain(
      "host trajetto_ci,trajetto_ci_probe all all scram-sha-256\n",
    );
  });

  it("takes the pool sizes from the environment", () => {
    const result = entrypoint({
      ...MINIMAL,
      PGBOUNCER_MAX_CLIENT_CONN: "500",
      PGBOUNCER_DEFAULT_POOL_SIZE: "8",
      PGBOUNCER_MAX_DB_CONNECTIONS: "40",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.ini).toBe(
      expectedIni(result.conf, {
        maxClientConn: "500",
        defaultPoolSize: "8",
        maxDbConnections: "40",
      }),
    );
  });

  it.each([
    ["PGBOUNCER_MAX_DB_CONNECTIONS", "sessenta", "60"],
    ["PGBOUNCER_MAX_DB_CONNECTIONS", "0", "60"],
    ["PGBOUNCER_MAX_DB_CONNECTIONS", "060", "60"],
    ["PGBOUNCER_MAX_DB_CONNECTIONS", "-5", "60"],
    ["PGBOUNCER_MAX_DB_CONNECTIONS", "5001", "60"],
    ["PGBOUNCER_MAX_CLIENT_CONN", "9", "2000"],
    ["PGBOUNCER_MAX_CLIENT_CONN", "99999999", "2000"],
    ["PGBOUNCER_DEFAULT_POOL_SIZE", "20 ", "20"],
  ])(
    "falls back on a bad %s (%j) with a warning, and still starts",
    (name, bad, fallback) => {
      const result = entrypoint({ ...MINIMAL, [name]: bad });
      const key = {
        PGBOUNCER_MAX_DB_CONNECTIONS: "max_db_connections",
        PGBOUNCER_MAX_CLIENT_CONN: "max_client_conn",
        PGBOUNCER_DEFAULT_POOL_SIZE: "default_pool_size",
      }[name];

      expect(result.status, result.stderr).toBe(0);
      expect(result.ini).toContain(`\n${key} = ${fallback}\n`);
      expect(result.stderr).toContain(
        `trajetto-pgbouncer: AVISO: ${name}=${bad} inválido`,
      );
      expect(result.argv).not.toBeNull();
    },
  );

  it.each([
    [
      "no primary host",
      { PGBOUNCER_PRIMARY_HOST: "" },
      "sem PGBOUNCER_PRIMARY_HOST",
    ],
    [
      "no auth password",
      { PGBOUNCER_AUTH_PASSWORD: "" },
      "sem PGBOUNCER_AUTH_PASSWORD",
    ],
    [
      "a host with a space",
      { PGBOUNCER_PRIMARY_HOST: "db port=1" },
      "PGBOUNCER_PRIMARY_HOST=db port=1 inválido",
    ],
    [
      "a socket path as host",
      { PGBOUNCER_PRIMARY_HOST: "/var/run/postgresql" },
      "inválido",
    ],
    ["two hosts", { PGBOUNCER_PRIMARY_HOST: "a,b" }, "inválido"],
    [
      "a port out of range",
      { PGBOUNCER_PRIMARY_PORT: "65536" },
      "PGBOUNCER_PRIMARY_PORT=65536 inválido",
    ],
    [
      "a port that is not a number",
      { PGBOUNCER_PRIMARY_PORT: "5432x" },
      "PGBOUNCER_PRIMARY_PORT=5432x inválido",
    ],
    [
      "an uppercase database",
      { PGBOUNCER_DATABASE: "Trajetto" },
      "PGBOUNCER_DATABASE=Trajetto inválido",
    ],
    [
      "a database that injects a line",
      { PGBOUNCER_DATABASE: "trajetto\nadmin_users = x" },
      "inválido",
    ],
    [
      "the console's own name",
      { PGBOUNCER_DATABASE: "pgbouncer" },
      "nome reservado",
    ],
    ["an hba keyword", { PGBOUNCER_DATABASE: "all" }, "nome reservado"],
    [
      "a database too long for the alias",
      { PGBOUNCER_DATABASE: "d".repeat(58) },
      "mais de 57 caracteres",
    ],
    [
      "a short auth password",
      { PGBOUNCER_AUTH_PASSWORD: "curta" },
      "PGBOUNCER_AUTH_PASSWORD com menos de 16 caracteres",
    ],
    [
      "an auth password on two lines",
      { PGBOUNCER_AUTH_PASSWORD: `${AUTH}\nx` },
      "PGBOUNCER_AUTH_PASSWORD tem quebra de linha",
    ],
    [
      "an auth password with a carriage return",
      { PGBOUNCER_AUTH_PASSWORD: `${AUTH}\r` },
      "tem quebra de linha",
    ],
    [
      "a SCRAM verifier as the auth password",
      { PGBOUNCER_AUTH_PASSWORD: "SCRAM-SHA-256$4096:c2FsdA==$a:b" },
      "verificador SCRAM",
    ],
    [
      "an md5 hash as the auth password",
      { PGBOUNCER_AUTH_PASSWORD: `md5${"0".repeat(32)}` },
      "parece um hash md5",
    ],
    [
      "a short stats password",
      { PGBOUNCER_STATS_PASSWORD: "curta" },
      "PGBOUNCER_STATS_PASSWORD com menos de 16",
    ],
    [
      "a short admin password",
      { PGBOUNCER_ADMIN_PASSWORD: "curta" },
      "PGBOUNCER_ADMIN_PASSWORD com menos de 16",
    ],
    [
      "the admin password equal to the stats one",
      { PGBOUNCER_ADMIN_PASSWORD: STATS, PGBOUNCER_STATS_PASSWORD: STATS },
      "igual à PGBOUNCER_STATS_PASSWORD",
    ],
  ])(
    "refuses to start with %s (64), before writing anything",
    (_, env, message) => {
      const result = entrypoint({ ...MINIMAL, ...env });

      // Where the connections go and who gets in never fall back to a
      // default: a start-first rolling keeps the old task while this fails.
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("trajetto-pgbouncer: ERRO: ");
      expect(result.stderr).toContain(message);
      expect(result.argv).toBeNull();
      expect(result.ini).toBeNull();
      expect(result.userlist).toBeNull();
      for (const secret of [AUTH, ADMIN, STATS]) {
        expect(result.stderr + result.stdout).not.toContain(secret);
      }
    },
  );

  it("keeps the auth_file to pgbouncer_auth and the console logins, quotes doubled", () => {
    const result = entrypoint({
      ...MINIMAL,
      PGBOUNCER_AUTH_PASSWORD: `${AUTH}"x`,
      PGBOUNCER_ADMIN_PASSWORD: ADMIN,
      PGBOUNCER_STATS_PASSWORD: STATS,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.userlist).toBe(
      [
        `"pgbouncer_auth" "${AUTH}""x"`,
        `"pgbouncer_admin" "${ADMIN}"`,
        `"pgbouncer_stats" "${STATS}"`,
        "",
      ].join("\n"),
    );
    expect(result.ini).toBe(
      expectedIni(result.conf, { admin: "pgbouncer_admin" }),
    );
    expect(result.stderr).toContain(
      "console: admin aberto (só 127.0.0.1), stats aberto",
    );
  });

  it("leaves the admin console out, and the stats login with a password nobody holds, when theirs are empty", () => {
    const first = entrypoint(MINIMAL);
    const firstStats = /^"pgbouncer_stats" "([0-9a-f]{64})"$/m.exec(
      first.userlist ?? "",
    )?.[1];
    const second = entrypoint(MINIMAL);
    const secondStats = /^"pgbouncer_stats" "([0-9a-f]{64})"$/m.exec(
      second.userlist ?? "",
    )?.[1];

    expect(first.userlist?.split("\n")).toEqual([
      `"pgbouncer_auth" "${AUTH}"`,
      expect.stringMatching(/^"pgbouncer_stats" "[0-9a-f]{64}"$/),
      "",
    ]);
    // Random at every start: the HEALTHCHECK's login exists, and nobody
    // can log in with it.
    expect(firstStats).toBeDefined();
    expect(secondStats).not.toBe(firstStats);
    expect(first.ini).toContain("\nadmin_users = \n");
    expect(first.stderr).toContain(
      "AVISO: sem PGBOUNCER_ADMIN_PASSWORD: o console de administração fica fechado",
    );
    expect(first.stderr).toContain(
      "AVISO: sem PGBOUNCER_STATS_PASSWORD: o login de estatística fica com uma senha aleatória",
    );
    expect(first.stderr).toContain(
      "console: admin fechado (só 127.0.0.1), stats fechado",
    );
  });

  it("opens the admin console only on 127.0.0.1 and keeps the service logins off the application database", () => {
    const result = entrypoint(MINIMAL);

    expect(result.hba).toBe(
      [
        "# Written by trajetto-pgbouncer-entrypoint.sh at every start.",
        "# TYPE  DATABASE  USER  ADDRESS  METHOD",
        "host replication all all reject",
        "host pgbouncer pgbouncer_admin 127.0.0.1/32 scram-sha-256",
        "host pgbouncer pgbouncer_stats all scram-sha-256",
        "host all pgbouncer_auth,pgbouncer_admin,pgbouncer_stats all reject",
        "host trajetto,trajetto_probe all all scram-sha-256",
        "",
      ].join("\n"),
    );
  });

  it("never prints a password, and leaves none in PgBouncer's environment", () => {
    const result = entrypoint({
      ...MINIMAL,
      PGBOUNCER_ADMIN_PASSWORD: ADMIN,
      PGBOUNCER_STATS_PASSWORD: STATS,
      APP_COMMIT_SHA: "0123456789abcdef",
    });

    expect(result.status, result.stderr).toBe(0);
    for (const secret of [AUTH, ADMIN, STATS]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.env).not.toContain(secret);
    }
    expect(result.env).not.toMatch(/^PGBOUNCER_\w*PASSWORD=/m);
    // What is not secret stays: the commit is in the first line it prints.
    expect(result.stderr).toContain(
      "trajetto-pgbouncer: imagem 0123456789abcdef; trajetto e trajetto_probe em trajetto-postgres-staging:5432",
    );
  });

  it.skipIf(process.platform === "win32")(
    "writes the files readable only by the image's user",
    () => {
      const result = entrypoint(MINIMAL);

      for (const name of ["pgbouncer.ini", "userlist.txt", "pg_hba.conf"]) {
        expect(statSync(`${result.conf}/${name}`).mode & 0o777, name).toBe(
          0o600,
        );
      }
    },
  );

  describe("the container's own arguments", () => {
    it("pass flags to PgBouncer, before the configuration file", () => {
      for (const args of [["pgbouncer", "-v"], ["-v"]]) {
        const result = entrypoint(MINIMAL, args);

        expect(result.status, result.stderr).toBe(0);
        expect(result.argv).toEqual(["-v", `${result.conf}/pgbouncer.ini`]);
      }
    });

    it("run any other command as given, with nothing written", () => {
      const result = entrypoint({}, ["psql", "--version"]);

      expect(result.status).toBe(0);
      expect(box.calls("psql")).toEqual(["psql --version"]);
      expect(result.argv).toBeNull();
      expect(result.ini).toBeNull();
    });
  });
});

describe("docs/variaveis-de-ambiente.md", () => {
  it("documents every variable the entrypoint reads, in the PgBouncer section", () => {
    const doc = read("docs/variaveis-de-ambiente.md");
    const start = doc.indexOf(
      "### PgBouncer (Application `trajetto-pgbouncer`",
    );
    const section = doc.slice(start, doc.indexOf("\n## ", start));
    const names = [
      ...new Set(
        read("infra/pgbouncer/entrypoint.sh").match(/\bPGBOUNCER_[A-Z_]+/g),
      ),
    ];

    expect(start).toBeGreaterThan(-1);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(section, name).toContain(`\`${name}\``);
  });
});
