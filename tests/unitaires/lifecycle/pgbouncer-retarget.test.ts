import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * infra/pgbouncer/retarget.sh (plano-escala F4-44): the failover's one
 * change on the runtime's side, run by the owner on the Dokploy host.
 *
 * It rewrites the Environment of a Dokploy Application, which holds every
 * password of the PgBouncer, and redeploys it in the worst minute of the
 * year. So: it refuses an Application that is not the PgBouncer, or one
 * pointed somewhere the owner did not expect; it changes exactly one line
 * and keeps every other byte; it never prints the key nor the Environment;
 * and it only says "done" when a healthy task of the service answers, from
 * inside, that it points at the new primary.
 *
 * Run for real, with a fake Dokploy (curl) and a fake Swarm (docker); the
 * JSON goes through the real Python, as on the host.
 */
const bash = hasShell("bash");

/** The host's python3; on a Windows machine, the python that works. */
function python(): string | null {
  for (const name of ["python3", "python"]) {
    const probe = spawnSync(name, ["-c", "import json"], { encoding: "utf8" });

    if (!probe.error && probe.status === 0) return name;
  }

  return null;
}

const PYTHON = python();
const APPLICATION_ID = "pgb_Ab12Cd34Ef56";
const KEY = "dokploy-key-never-printed";
const AUTH = "auth-pass-never-printed";
const OLD = "trajetto-postgres-staging";
const NEW = "trajetto-postgres-standby-staging";

const ENVIRONMENT = [
  "PGBOUNCER_DATABASE=trajetto",
  `PGBOUNCER_PRIMARY_HOST=${OLD}\r`,
  `PGBOUNCER_AUTH_PASSWORD=${AUTH}`,
  "PGBOUNCER_MAX_DB_CONNECTIONS=60",
  "# a comment the owner wrote",
].join("\n");

let box: Sandbox;

function application(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APPLICATION_ID,
    appName: "trajetto-pgbouncer-staging",
    sourceType: "docker",
    dockerImage: "ghcr.io/trajetto-organization/trajetto-pgbouncer:staging",
    env: ENVIRONMENT,
    buildArgs: null,
    ...overrides,
  };
}

/** What the new task answers: the env it runs with and SHOW DATABASES. */
function swarm(host: string, databasesHost = host) {
  box.file("spec-env.next", `PGBOUNCER_PRIMARY_HOST=${host}\nX=1\n`);
  box.file(
    "container-env",
    `PGBOUNCER_PRIMARY_HOST=${host}\nPGBOUNCER_STATS_PASSWORD=stats-never-printed\n`,
  );
  box.file(
    "databases",
    [
      `trajetto|${databasesHost}|5432|trajetto||20|0||0|60|0|0|0`,
      `trajetto_probe|${databasesHost}|5432|trajetto||2|0||0|2|0|0|0`,
      "pgbouncer||6432|pgbouncer|pgbouncer|2|0|statement|0|0|0|0|0",
    ].join("\n") + "\n",
  );
}

beforeEach(() => {
  box = sandbox();
  writeFileSync(`${box.root}/app.json`, JSON.stringify(application()));
  box.file("spec-env", `PGBOUNCER_PRIMARY_HOST=${OLD}\n`);
  box.file("healthy", "c0ffee\n");
  swarm(NEW);

  // The panel: application.one, saveEnvironment and deploy.
  box.stub(
    "curl",
    `
out=""; data=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --data-binary) data=\${2#@}; shift 2 ;;
    -H|-w|-X|--max-time) shift 2 ;;
    -sS) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */api/application.one*) cat "${box.root}/app.json" > "$out"; code=200 ;;
  */api/application.saveEnvironment) cp "$data" "${box.root}/saved.json"; echo '{}' > "$out"; code=\${STUB_SAVE_STATUS:-200} ;;
  */api/application.deploy) cp "$data" "${box.root}/deployed.json"; cp "${box.root}/spec-env.next" "${box.root}/spec-env"; echo true > "$out"; code=200 ;;
  *) code=404 ;;
esac
printf '%s' "$code"`,
  );
  // The Swarm on this manager.
  box.stub(
    "docker",
    `
case "$1" in
  service) cat "${box.root}/spec-env" ;;
  ps) cat "${box.root}/healthy" 2> /dev/null ;;
  inspect) cat "${box.root}/container-env" ;;
  exec) cat "${box.root}/databases" ;;
esac`,
  );
  box.stub("sleep", "exit 0");
});

afterEach(() => box.dispose());

function retarget(args: string[], env: Record<string, string> = {}) {
  return run("bash", repoFile("infra/pgbouncer/retarget.sh"), args, {
    bin: box.bin,
    env: {
      DOKPLOY_URL: "http://localhost:3000",
      DOKPLOY_API_KEY: KEY,
      RETARGET_PYTHON: PYTHON ?? "python3",
      RETARGET_TIMEOUT_SECONDS: "10",
      ...env,
    },
  });
}

const saved = () =>
  existsSync(`${box.root}/saved.json`)
    ? (JSON.parse(readFileSync(`${box.root}/saved.json`, "utf8")) as {
        applicationId: string;
        env: string;
        buildArgs: unknown;
      })
    : null;

describe.skipIf(!bash || !PYTHON)("infra/pgbouncer/retarget.sh", () => {
  it("changes PGBOUNCER_PRIMARY_HOST alone, deploys, and says done only when the new task points there", () => {
    const { status, stderr } = retarget([
      APPLICATION_ID,
      NEW,
      "--expect-current",
      OLD,
    ]);

    expect(status, stderr).toBe(0);
    // Exactly one line changed; the CR, the comment and the passwords as
    // they were.
    expect(saved()).toEqual({
      applicationId: APPLICATION_ID,
      env: ENVIRONMENT.replace(
        `PGBOUNCER_PRIMARY_HOST=${OLD}\r`,
        `PGBOUNCER_PRIMARY_HOST=${NEW}\r`,
      ),
      buildArgs: null,
      buildSecrets: null,
    });
    expect(
      JSON.parse(readFileSync(`${box.root}/deployed.json`, "utf8")),
    ).toEqual({ applicationId: APPLICATION_ID });
    expect(stderr).toContain(`trajetto-pgbouncer-staging aponta para ${OLD}`);
    expect(stderr).toMatch(
      new RegExp(
        `\\[ *\\d+s\\] trajetto-pgbouncer-staging aponta para ${NEW}: a tarefa nova está saudável`,
      ),
    );
  });

  it("never puts the key on a command line, nor the key or the Environment in its output", () => {
    const { status, stdout, stderr } = retarget([APPLICATION_ID, NEW]);
    const everything = stdout + stderr + box.calls().join("\n");

    expect(status, stderr).toBe(0);
    for (const secret of [KEY, AUTH, "stats-never-printed"]) {
      expect(everything).not.toContain(secret);
    }
    // curl reads the header from a file.
    expect(box.calls("curl")[0]).toMatch(/-H @\S+\/headers /);
  });

  it("refuses an Application that is not the PgBouncer, before writing anything", () => {
    writeFileSync(
      `${box.root}/app.json`,
      JSON.stringify(
        application({
          appName: "trajetto-api-staging",
          dockerImage: "ghcr.io/trajetto-organization/trajetto-api:staging",
        }),
      ),
    );

    const { status, stderr } = retarget([APPLICATION_ID, NEW]);

    expect(status).toBe(3);
    expect(stderr).toContain("não é a trajetto-pgbouncer");
    expect(saved()).toBeNull();
    expect(existsSync(`${box.root}/deployed.json`)).toBe(false);
  });

  it("refuses when the PgBouncer points somewhere else than the owner expects", () => {
    const { status, stderr } = retarget([
      APPLICATION_ID,
      NEW,
      "--expect-current",
      "trajetto-postgres-production",
    ]);

    expect(status).toBe(3);
    expect(stderr).toContain(
      `aponta para ${OLD}, não para trajetto-postgres-production`,
    );
    expect(saved()).toBeNull();
  });

  it.each([
    ["no line", "PGBOUNCER_DATABASE=trajetto", "0 linhas"],
    [
      "two lines",
      `PGBOUNCER_PRIMARY_HOST=${OLD}\nPGBOUNCER_PRIMARY_HOST=${NEW}`,
      "2 linhas",
    ],
  ])("refuses an Environment with %s", (_case, env, reason) => {
    writeFileSync(`${box.root}/app.json`, JSON.stringify(application({ env })));

    const { status, stderr } = retarget([APPLICATION_ID, NEW]);

    expect(status).toBe(3);
    expect(stderr).toContain(reason);
    expect(saved()).toBeNull();
  });

  it("only checks when it already points at the new host", () => {
    writeFileSync(
      `${box.root}/app.json`,
      JSON.stringify(application({ env: ENVIRONMENT.replace(OLD, NEW) })),
    );
    box.file("spec-env", `PGBOUNCER_PRIMARY_HOST=${NEW}\n`);

    const { status, stderr } = retarget([APPLICATION_ID, NEW]);

    expect(status, stderr).toBe(0);
    expect(stderr).toContain("nada a trocar");
    expect(saved()).toBeNull();
    expect(existsSync(`${box.root}/deployed.json`)).toBe(false);
  });

  it("says what it would do with --dry-run, and does nothing", () => {
    const { status, stderr } = retarget([APPLICATION_ID, NEW, "--dry-run"]);

    expect(status).toBe(0);
    expect(stderr).toContain(
      `trocaria PGBOUNCER_PRIMARY_HOST de ${OLD} para ${NEW}`,
    );
    expect(saved()).toBeNull();
    expect(box.calls("docker")).toEqual([]);
  });

  it("stops before the deploy when Dokploy refuses the Environment, and points at --wait-only", () => {
    const { status, stderr } = retarget([APPLICATION_ID, NEW], {
      STUB_SAVE_STATUS: "400",
    });

    expect(status).toBe(4);
    expect(stderr).toContain(
      "recusou /api/application.saveEnvironment (HTTP 400)",
    );
    expect(stderr).toContain("--wait-only");
    expect(existsSync(`${box.root}/deployed.json`)).toBe(false);
  });

  it("only waits and checks with --wait-only, after a change made in the panel", () => {
    box.file("spec-env", `PGBOUNCER_PRIMARY_HOST=${NEW}\n`);

    const { status, stderr } = retarget([APPLICATION_ID, NEW, "--wait-only"]);

    expect(status, stderr).toBe(0);
    expect(saved()).toBeNull();
    expect(existsSync(`${box.root}/deployed.json`)).toBe(false);
  });

  it("fails when no healthy task runs the new host in time", () => {
    box.file("healthy", "");

    const { status, stderr } = retarget([APPLICATION_ID, NEW]);

    expect(status).toBe(5);
    expect(stderr).toContain("nenhuma tarefa saudável");
  });

  it("fails when the new task still points at the old primary", () => {
    swarm(NEW, OLD);

    const { status, stderr } = retarget([APPLICATION_ID, NEW]);

    expect(status).toBe(5);
    expect(stderr).toContain(`não aponta só para ${NEW}`);
  });

  it.each([
    [["only-one-argument"], 2],
    [[APPLICATION_ID, "db host=evil"], 2],
    [[APPLICATION_ID, NEW, "--expect-current"], 2],
    [[APPLICATION_ID, NEW, "--force"], 2],
  ])("refuses the usage %j", (args, code) => {
    const { status } = retarget(args as string[]);

    expect(status).toBe(code);
    expect(box.calls("curl")).toEqual([]);
  });

  it("refuses to run without the key", () => {
    const { status, stderr } = retarget([APPLICATION_ID, NEW], {
      DOKPLOY_API_KEY: "",
    });

    expect(status).toBe(2);
    expect(stderr).toContain("DOKPLOY_API_KEY ausente");
  });
});

describe("the script in the repository", () => {
  it("is executable and LF on any checkout", () => {
    const mode = spawnSync(
      "git",
      ["ls-files", "-s", "infra/pgbouncer/retarget.sh"],
      { encoding: "utf8" },
    ).stdout;

    expect(mode).toMatch(/^100755 /);
    expect(read(".gitattributes")).toMatch(/^infra\/pgbouncer\/\*\* /m);
  });
});

function read(path: string): string {
  return readFileSync(repoFile(path), "utf8");
}
