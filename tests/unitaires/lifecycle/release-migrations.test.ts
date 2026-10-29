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
 * resolved it by hand. As a one-off Swarm job run by the promote workflow (on
 * the Dokploy host, which runs the Applications in Swarm), a failing migration fails
 * one step, `stable` does not move and the running replicas never notice.
 */
const sh = hasShell("sh");

const IMAGE = "ghcr.io/trajetto-organization/trajetto-api:sha-0a1b2c3";

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
  "service ps") echo "\${STUB_STATE:-Complete 3 seconds ago}" ;;
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
    "ghcr.io/trajetto-organization/trajetto-api:latest",
    "ghcr.io/trajetto-organization/trajetto-api:stable",
    "ghcr.io/trajetto-organization/trajetto-ui:sha-0a1b2c3",
    "ghcr.io/trajetto-organization/trajetto-api:staging-0a1b2c3",
    `${IMAGE}; docker swarm leave --force`,
    "",
  ])("refuses %j without touching docker", (image) => {
    const result = release(image ? [image] : []);

    expect(result.status).not.toBe(0);
    expect(box.calls("docker")).toEqual([]);
  });

  it("accepts the main-<sha> builds published before the staging branch (a rollback target)", () => {
    const result = release([
      "ghcr.io/trajetto-organization/trajetto-api:main-0a1b2c3",
    ]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      box
        .calls("docker")
        .some((call) => call.startsWith("docker service create")),
    ).toBe(true);
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
    // The image's HEALTHCHECK probes :3333, which a migration never opens:
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
    const result = release([], { SSH_ORIGINAL_COMMAND: IMAGE });

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

describe("the promote workflow", () => {
  const workflow = readFileSync(
    repoFile(".github/workflows/deploy.yml"),
    "utf8",
  );
  const job = workflow.slice(workflow.indexOf("\n  promote-production:"));
  const steps = job.split(/\n      - name: /).slice(1);
  const index = (name: string) =>
    steps.findIndex((step) => step.startsWith(name));

  it("migrates once, before `stable` moves and before the stack is told to pull", () => {
    const migrate = index("Run database migrations");

    expect(migrate, "passo de migração no promote").toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(index("Promote image to stable"));
    expect(migrate).toBeLessThan(index("Deploy to production (Dokploy)"));
  });

  it("is switched on by a repository variable, and hands over no raw input", () => {
    const step = steps[index("Run database migrations")] ?? "";

    expect(step).toContain("if: vars.MIGRATIONS_VIA_JOB == 'true'");
    expect(step).toContain("IMAGE_TAG: ${{ steps.target.outputs.tag }}");
    expect(step.slice(step.indexOf("run:"))).not.toContain("${{");
  });

  it("keeps the SSH session alive through a long, silent migration", () => {
    // The script prints nothing while it polls (up to 15 min). An idle TCP
    // flow is dropped by the runner's NAT after a few minutes, and the step
    // then hangs on a session that no longer exists.
    const step = steps[index("Run database migrations")] ?? "";
    const command = step.slice(step.indexOf("ssh -i"));

    // The option on the ssh command line itself, before the destination.
    expect(command).toMatch(
      /^ssh -i[\s\S]*?-o ServerAliveInterval=\d+[\s\S]*?"\$SSH_USER@/,
    );
  });
});

describe("the image's boot", () => {
  it("migrates on boot unless the API Application switches it off for the job", () => {
    // Unset in the Application's environment, the entrypoint keeps migrating
    // on boot; MIGRATIONS_VIA_JOB pairs with RUN_MIGRATIONS_ON_BOOT=false.
    const entrypoint = readFileSync(
      repoFile("infra/scripts/docker-entrypoint.sh"),
      "utf8",
    );

    expect(entrypoint).toContain('"${RUN_MIGRATIONS_ON_BOOT:-true}" = "true"');
  });
});
