import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * Migrations as ONE release step, before the rollout — not at the boot of
 * every replica.
 *
 * At boot, a migration that failed or ran past the liveness budget left a row
 * with `finished_at` NULL in `_prisma_migrations`, and from then on every
 * `migrate deploy` of every image version — the old one included — refused to
 * run (P3009). The next restart of any replica was an outage until someone
 * resolved it by hand. As a one-off Swarm job, run by the staging deploy and
 * by the promote (on the Dokploy host, which runs the Applications in
 * Swarm), a failing migration fails one step, no tag moves and the running
 * replicas never notice. The API image no longer carries the Prisma CLI at
 * all: the job runs the release image (trajetto-api-migrate).
 */
const sh = hasShell("sh");
const bash = hasShell("bash");

const IMAGE = "ghcr.io/trajetto-organization/trajetto-api-migrate:sha-0a1b2c3";
const BY_DIGEST = `ghcr.io/trajetto-organization/trajetto-api-migrate@sha256:${"0".repeat(64)}`;

const DOCKER = `
case "$1 $2" in
  "network inspect") exit "\${STUB_NETWORK_EXIT:-0}" ;;
  "service inspect")
    [ "\${STUB_SERVICE_EXIT:-0}" = 0 ] || exit 1
    printf 'NODE_ENV=production\\nDATABASE_URL=postgresql://u:p@db/x\\n\\n' ;;
  "service create")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--env-file" ]; then
        printf '%s' "$2" > "$STUB_ENV_PATH"
        cp "$2" "$STUB_ENV_COPY"
      fi
      shift
    done ;;
  "service ps")
    case "$*" in
      *Error*) echo "\${STUB_ERROR:-}" ;;
      *) echo "\${STUB_STATE:-Complete 3 seconds ago}" ;;
    esac ;;
  "service logs") echo "migrate-job-log-line" ;;
  "service rm") ;;
esac
exit 0`;

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
  box.stub("docker", DOCKER);
});

afterEach(() => box.dispose());

function release(args: string[], env: Record<string, string> = {}) {
  return run("sh", repoFile("infra/scripts/run-release-migrations.sh"), args, {
    bin: box.bin,
    env: {
      STUB_ENV_PATH: `${box.root}/env-path`,
      STUB_ENV_COPY: `${box.root}/env-copy`,
      MIGRATE_POLL_SECONDS: "0",
      API_SERVICE: "trajetto-api-a1b2c3",
      ...env,
    },
  });
}

describe.skipIf(!sh)("the release migration job", () => {
  it.each([
    // The API image cannot migrate: it carries no Prisma CLI.
    "ghcr.io/trajetto-organization/trajetto-api:sha-0a1b2c3",
    "ghcr.io/trajetto-organization/trajetto-api:main-0a1b2c3",
    "ghcr.io/trajetto-organization/trajetto-api-migrate:latest",
    "ghcr.io/trajetto-organization/trajetto-api-migrate:staging",
    "ghcr.io/trajetto-organization/trajetto-api-migrate:staging-0a1b2c3",
    "ghcr.io/trajetto-organization/trajetto-api-migrate@sha256:0a1b2c3",
    "ghcr.io/trajetto-organization/trajetto-ui:sha-0a1b2c3",
    // A valid first line must not carry a second one onto the docker command
    // line (grep matches line by line).
    `${IMAGE}\n--network host`,
    `${IMAGE}; docker swarm leave --force`,
    "",
  ])("refuses %j without touching docker", (image) => {
    const result = release(image ? [image] : []);

    expect(result.status).not.toBe(0);
    expect(box.calls("docker")).toEqual([]);
  });

  it("accepts the release image by the digest the pipeline built", () => {
    const result = release([BY_DIGEST]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      box
        .calls("docker")
        .find((call) => call.startsWith("docker service create")),
    ).toContain(`${BY_DIGEST} ./docker-entrypoint.sh migrate`);
  });

  it("runs the image as a one-off job with no healthcheck, and removes it", () => {
    const result = release([IMAGE]);

    expect(result.status, result.stdout + result.stderr).toBe(0);

    const create = box
      .calls("docker")
      .find((call) => call.startsWith("docker service create"));

    expect(create).toBeDefined();
    expect(create).toContain("--mode replicated-job");
    expect(create).toContain("--restart-condition none");
    // The API's HEALTHCHECK probes :3333, which a migration never opens:
    // with it, Swarm would kill the job halfway through a migration.
    expect(create).toContain("--no-healthcheck");
    expect(create).toContain("--with-registry-auth");
    expect(create).toMatch(
      new RegExp(
        `${IMAGE.replace(/[.]/g, "\\.")} \\./docker-entrypoint\\.sh migrate$`,
      ),
    );

    expect(
      box.calls("docker").some((call) => call.startsWith("docker service rm")),
    ).toBe(true);
    expect(result.stdout).toContain("migrate-job-log-line");
  });

  it("takes the credentials from the running API service, and deletes the copy", () => {
    const tmp = `${box.root}/tmp`;

    mkdirSync(tmp);
    release([IMAGE], { TMPDIR: tmp });

    expect(readFileSync(`${box.root}/env-copy`, "utf8")).toContain(
      "DATABASE_URL=",
    );
    expect(existsSync(`${box.root}/env-path`)).toBe(true);
    // Nothing left where mktemp wrote it: the file held the database password.
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("accepts the image through a forced-command SSH key", () => {
    const result = release([], { SSH_ORIGINAL_COMMAND: BY_DIGEST });

    expect(result.status, result.stderr).toBe(0);
  });

  it("joins dokploy-network, where the Dokploy Postgres service is", () => {
    release([IMAGE]);

    expect(
      box.calls("docker").find((call) => call.includes("service create")),
    ).toContain("--network dokploy-network");
  });

  it("reuses the env of the service API_SERVICE names (the Application's appName)", () => {
    const result = release([IMAGE], {
      API_SERVICE: "trajetto-api-x1y2",
      MIGRATE_NETWORK: "other-overlay",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      box
        .calls("docker")
        .some(
          (call) =>
            call.startsWith("docker service inspect --format") &&
            call.endsWith(" trajetto-api-x1y2"),
        ),
    ).toBe(true);
    expect(
      box.calls("docker").find((call) => call.includes("service create")),
    ).toContain("--network other-overlay");
  });

  it.each([
    ["unset", ""],
    ["with shell in it", "trajetto-api;id"],
    ["with a second line", "trajetto-api\nid"],
  ])("refuses an API_SERVICE %s, without touching docker", (_what, service) => {
    // A Dokploy service name carries a random suffix: there is no default
    // worth guessing, and the job must never borrow another service's env.
    const result = release([IMAGE], { API_SERVICE: service });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("API_SERVICE");
    expect(box.calls("docker")).toEqual([]);
  });

  it.each([
    ["network", { STUB_NETWORK_EXIT: "1" }, "MIGRATE_NETWORK"],
    ["API service", { STUB_SERVICE_EXIT: "1" }, "API_SERVICE"],
  ])(
    "refuses when the %s does not exist, creating nothing",
    (_what, env, hint) => {
      const result = release([IMAGE], env);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(hint);
      expect(
        box.calls("docker").some((call) => call.includes("service create")),
      ).toBe(false);
    },
  );

  it("fails the step when the job fails, and shows why", () => {
    const result = release([IMAGE], { STUB_STATE: "Failed 2 seconds ago" });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("migrate-job-log-line");
    expect(result.stderr).toMatch(/P3009/);
  });

  it("says why a job that never started was refused (a pull GHCR denied leaves no log)", () => {
    const result = release([IMAGE], {
      STUB_STATE: "Rejected 3 seconds ago",
      STUB_ERROR:
        "No such image: ghcr.io/trajetto-organization/trajetto-api-migrate:sha-0a1b2c3",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No such image");
    expect(result.stderr).toContain("docker login ghcr.io do usuário deploy");
  });

  it("on timeout fails, but leaves a running migration alone", () => {
    // Removing the service kills the container mid-migration: exactly the
    // interrupted run that leaves P3009 behind.
    const result = release([IMAGE], {
      STUB_STATE: "Running 14 minutes ago",
      MIGRATE_TIMEOUT_SECONDS: "0",
    });

    expect(result.status).not.toBe(0);
    expect(
      box.calls("docker").some((call) => call.startsWith("docker service rm")),
    ).toBe(false);
    expect(result.stderr).toMatch(/trajetto-migrate-/);
  });

  it.each(["INT", "TERM", "HUP"])(
    "on SIG%s while waiting, leaves the running migration alone and still drops the env copy",
    (signal) => {
      // A Ctrl-C on the manager, a cancelled run, a dropped SSH session: the
      // wait ends, the migration must not. `sleep` runs between polls in the
      // script's own shell, so the stub signals that shell.
      box.stub("sleep", `kill -${signal} "$PPID"`);

      const tmp = `${box.root}/tmp`;

      mkdirSync(tmp);

      const result = release([IMAGE], {
        STUB_STATE: "Running 5 seconds ago",
        MIGRATE_TIMEOUT_SECONDS: "600",
        TMPDIR: tmp,
      });

      expect(result.status).not.toBe(0);
      expect(
        box
          .calls("docker")
          .some((call) => call.startsWith("docker service rm")),
      ).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    },
  );
});

/**
 * The CI side (.github/scripts/release-migrations.sh), with `ssh` stubbed:
 * attempt N exits STUB_SSH_EXIT_<N> (else 0) after printing STUB_SSH_OUT_<N>.
 */
const SSH = `
count="$STUB_DIR/ssh-count"
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$count"
for arg in "$@"; do
  case "$arg" in UserKnownHostsFile=*) cp "\${arg#UserKnownHostsFile=}" "$STUB_DIR/known-hosts-seen" ;; esac
done
eval "out=\\\${STUB_SSH_OUT_$n:-}"
eval "code=\\\${STUB_SSH_EXIT_$n:-0}"
[ -z "$out" ] || printf '%s\\n' "$out"
exit "$code"`;

describe.skipIf(!bash)("the CI side of the release step", () => {
  const secrets = {
    ENVIRONMENT: "staging",
    SSH_HOST: "deploy.example.invalid",
    SSH_USER: "deploy",
    SSH_KEY:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
    SSH_KNOWN_HOSTS: "deploy.example.invalid ssh-ed25519 AAAAfake",
  };

  function client(args: string[], env: Record<string, string> = {}) {
    box.stub("ssh", SSH);

    const tmp = `${box.root}/tmp`;

    mkdirSync(tmp, { recursive: true });

    const result = run(
      "bash",
      repoFile(".github/scripts/release-migrations.sh"),
      args,
      {
        bin: box.bin,
        env: {
          STUB_DIR: box.root,
          SSH_RETRY_SECONDS: "0",
          TMPDIR: tmp,
          ...secrets,
          ...env,
        },
      },
    );

    return { ...result, log: result.stdout + result.stderr, tmp };
  }

  it("sends the image and nothing else, to a host it already knows", () => {
    const result = client([BY_DIGEST]);

    expect(result.status, result.log).toBe(0);

    const [call] = box.calls("ssh");

    expect(call.endsWith(`deploy@deploy.example.invalid ${BY_DIGEST}`)).toBe(
      true,
    );
    expect(call).toContain("-o BatchMode=yes");
    expect(call).toContain("-o StrictHostKeyChecking=yes");
    expect(readFileSync(`${box.root}/known-hosts-seen`, "utf8")).toContain(
      secrets.SSH_KNOWN_HOSTS,
    );
  });

  it("keeps the session alive through a long, silent migration", () => {
    // The host's script prints nothing while it polls (up to 15 min). An
    // idle TCP flow is dropped by the runner's NAT after a few minutes, and
    // the step then hangs on a session that no longer exists.
    client([BY_DIGEST]);

    expect(box.calls("ssh")[0]).toMatch(/-o ServerAliveInterval=\d+/);
  });

  it("leaves no key behind", () => {
    const result = client([BY_DIGEST]);

    expect(readdirSync(result.tmp)).toEqual([]);
  });

  it("refuses to run without the image", () => {
    const result = client([]);

    expect(result.status).toBe(2);
    expect(box.calls("ssh")).toEqual([]);
  });

  it("names every missing secret, and says the deploy cannot go without them", () => {
    const result = client([BY_DIGEST], { SSH_KEY: "", SSH_KNOWN_HOSTS: "" });

    expect(result.status).toBe(1);
    expect(result.log).toContain("DEPLOY_SSH_KEY DEPLOY_SSH_KNOWN_HOSTS");
    expect(result.log).toContain("environment staging");
    expect(box.calls("ssh")).toEqual([]);
  });

  it("tries again a connection that never opened, saying so", () => {
    const result = client([BY_DIGEST], {
      STUB_SSH_EXIT_1: "255",
      STUB_SSH_OUT_1:
        "ssh: connect to host deploy.example.invalid port 22: Connection timed out",
    });

    expect(result.status, result.log).toBe(0);
    expect(box.calls("ssh")).toHaveLength(2);
    expect(result.log).toMatch(
      /::warning::O SSH .* não abriu \(tentativa 1 de 3/,
    );
  });

  it("gives up on the network after three attempts, as a network failure", () => {
    const result = client([BY_DIGEST], {
      STUB_SSH_EXIT_1: "255",
      STUB_SSH_EXIT_2: "255",
      STUB_SSH_EXIT_3: "255",
    });

    expect(result.status).toBe(1);
    expect(box.calls("ssh")).toHaveLength(3);
    expect(result.log).toContain("Nenhuma migration rodou");
  });

  it("never tries again once the host answered: the job may be migrating", () => {
    // A session that dropped after the host started: a second job would
    // race the first for Prisma's advisory lock.
    const result = client([BY_DIGEST], {
      STUB_SSH_EXIT_1: "255",
      STUB_SSH_OUT_1: `[release-migrations] ${BY_DIGEST} como job trajetto-migrate-1 na rede dokploy-network`,
    });

    expect(result.status).toBe(255);
    expect(box.calls("ssh")).toHaveLength(1);
  });

  it("passes the host's failure through, without trying again", () => {
    const result = client([BY_DIGEST], {
      STUB_SSH_EXIT_1: "1",
      STUB_SSH_OUT_1:
        "[release-migrations] ERRO: o job terminou em 'Failed 2 seconds ago'.",
    });

    expect(result.status).toBe(1);
    expect(box.calls("ssh")).toHaveLength(1);
    expect(result.log).toContain("O job de migrations falhou no host");
  });
});

describe("the deploy workflows", () => {
  const workflow = readFileSync(
    repoFile(".github/workflows/deploy.yml"),
    "utf8",
  );

  function stepsOf(name: string) {
    const start = workflow.indexOf(`\n  ${name}:`);
    const end = workflow.indexOf("\n  # ──", start + 1);
    const job = workflow.slice(start, end === -1 ? undefined : end);
    const steps = job.split(/\n      - name: /).slice(1);
    const index = (step: string) =>
      steps.findIndex((each) => each.startsWith(step));

    return { steps, index };
  }

  const staging = stepsOf("deploy-staging");
  const promote = stepsOf("promote-production");

  it("staging migrates once, before any tag moves or Dokploy is told to pull", () => {
    const migrate = staging.index("Run database migrations");

    expect(migrate, "passo de migração no deploy de staging").toBeGreaterThan(
      -1,
    );
    expect(migrate).toBeGreaterThan(
      staging.index("Is the staging deploy configured?"),
    );
    expect(migrate).toBeLessThan(
      staging.index("Move the AI's staging tag to this build"),
    );
    expect(migrate).toBeLessThan(staging.index("Move staging to this build"));
    expect(migrate).toBeLessThan(staging.index("Deploy to staging (Dokploy)"));
  });

  it("staging runs the release image this run built, by digest", () => {
    const step = staging.steps[staging.index("Run database migrations")];

    expect(step).toContain(
      "MIGRATE_DIGEST: ${{ needs.build-and-push.outputs.migrate_digest }}",
    );
    expect(step).toContain(
      '"ghcr.io/trajetto-organization/trajetto-api-migrate@${MIGRATE_DIGEST}"',
    );
  });

  it("the promote migrates once, before `stable` moves and before production is told to pull", () => {
    const migrate = promote.index("Run database migrations");

    expect(migrate, "passo de migração no promote").toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(
      promote.index("Is the production deploy configured?"),
    );
    expect(migrate).toBeLessThan(promote.index("Promote image to stable"));
    expect(migrate).toBeLessThan(
      promote.index("Deploy to production (Dokploy)"),
    );
  });

  it("the promote runs the release image of the promoted build, and skips a build older than it", () => {
    const step = promote.steps[promote.index("Run database migrations")];

    // The build the staging check settled on (promote-workflow.test.ts).
    expect(step).toContain("IMAGE_TAG: ${{ steps.staged.outputs.tag }}");
    expect(step).toContain(
      'ghcr.sh digest "ghcr.io/trajetto-organization/trajetto-api-migrate:${IMAGE_TAG}"',
    );
    expect(step).toMatch(/if \[ -z "\$digest" \]; then[\s\S]*?exit 0/);
  });

  it.each([
    ["staging", staging],
    ["promote", promote],
  ])(
    "%s: only when Dokploy deploys, through the shared script, handing over no raw input",
    (_name, job) => {
      const step = job.steps[job.index("Run database migrations")];

      expect(step).toContain("if: ");
      expect(step).toContain("steps.dokploy.outputs.enabled == 'true'");
      expect(step).toContain("bash .github/scripts/release-migrations.sh");
      expect(step).toContain("SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}");
      expect(step.slice(step.indexOf("run:"))).not.toContain("${{");
    },
  );

  it("has the promote fail closed on a build that lost its release image", () => {
    const step = promote.steps[promote.index("Run database migrations")];

    expect(step).toContain("EVENT: ${{ github.event_name }}");
    expect(step).toContain("infra/scripts/schema-guard.ts");
  });

  it("has no switch left to keep migrating on boot", () => {
    // The API image cannot migrate; a variable that pretended otherwise
    // would only mislead.
    for (const file of [
      ".github/workflows/deploy.yml",
      "Dockerfile",
      "infra/scripts/docker-entrypoint.sh",
    ]) {
      const text = readFileSync(repoFile(file), "utf8");

      expect(text, file).not.toContain("MIGRATIONS_VIA_JOB");
      expect(text, file).not.toContain("RUN_MIGRATIONS_ON_BOOT");
    }
  });
});

/**
 * The promote's migration step, run: `ghcr.sh` and the CI side of the job
 * stubbed under .github/scripts, git real, in a repository with one commit
 * from before the release image (no infra/scripts/schema-guard.ts) and one
 * from after it. A build with no release image is skipped only when it
 * provably predates it; any other lost its push, and the step fails before
 * `stable` moves.
 */
describe.skipIf(!bash)("the promote's migration step, run", () => {
  const workflow = readFileSync(
    repoFile(".github/workflows/deploy.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const job = workflow.slice(workflow.indexOf("\n  promote-production:"));
  const stepText = job
    .split(/\n      - name: /)
    .find((step) => step.startsWith("Run database migrations"))!;

  /** The step's `run: |` block, dedented. */
  const runBlock = (() => {
    const lines = stepText.split("\n");
    const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));
    const indent = lines[at].search(/\S/) + 2;
    const body: string[] = [];

    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && line.search(/\S/) < indent) break;
      body.push(line.slice(indent));
    }

    return body.join("\n");
  })();

  let before = "";
  let after = "";

  beforeEach(() => {
    // A throwaway repository: no global identity or signing needed.
    box.file(
      "tests-git.sh",
      'exec git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"\n',
    );
    const g = (...args: string[]) =>
      run("bash", `${box.root}/tests-git.sh`, args, {
        cwd: box.root,
      }).stdout.trim();

    g("init", "-q");
    box.file("README", "x");
    g("add", "README");
    g("commit", "-q", "-m", "before the release image");
    before = g("rev-parse", "HEAD");
    box.file("infra/scripts/schema-guard.ts", "// the guard");
    g("add", "infra/scripts/schema-guard.ts");
    g("commit", "-q", "-m", "the release image");
    after = g("rev-parse", "HEAD");

    box.file(".github/scripts/ghcr.sh", 'printf "%s" "${STUB_DIGEST:-}"\n');
    box.file(
      ".github/scripts/release-migrations.sh",
      `printf '%s\\n' "$*" >> "${box.root}/released"\n`,
    );
  });

  function promote(tag: string, event: string, digest = "") {
    const summary = `${box.root}/summary`;
    const script = box.file("step.sh", `set -eo pipefail\n${runBlock}`);
    const result = run("bash", script, [], {
      cwd: box.root,
      env: {
        IMAGE_TAG: tag,
        EVENT: event,
        STUB_DIGEST: digest,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    const released = existsSync(`${box.root}/released`)
      ? readFileSync(`${box.root}/released`, "utf8").trim()
      : "";

    return { ...result, log: result.stdout + result.stderr, released };
  }

  it("migrates with the release image of the build, by digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const result = promote(`sha-${after.slice(0, 7)}`, "push", digest);

    expect(result.status, result.log).toBe(0);
    expect(result.released).toBe(
      `ghcr.io/trajetto-organization/trajetto-api-migrate@${digest}`,
    );
  });

  it("fails a merge whose build has no release image: its push failed", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "push");

    expect(result.status).toBe(1);
    expect(result.log).toContain("o push dela falhou");
    expect(result.released).toBe("");
  });

  it("fails a rollback to a build from after the release image that has none", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status).toBe(1);
    expect(result.released).toBe("");
  });

  it("skips, with a notice, a rollback to a build from before the release image", () => {
    const result = promote(`sha-${before.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain("anterior à imagem de migração");
    expect(result.released).toBe("");
  });

  it("skips the main-<sha> builds, all from before the staging branch", () => {
    const result = promote("main-0a1b2c3", "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.released).toBe("");
  });

  it("fails closed on a commit it cannot find", () => {
    const result = promote("sha-ffffff0", "workflow_dispatch");

    expect(result.status).toBe(1);
  });
});
