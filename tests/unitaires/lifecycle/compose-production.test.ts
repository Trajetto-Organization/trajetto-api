import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Redis in production answers only to the password.
 *
 * It sat on an overlay shared with the web server and anything else deployed
 * next to it, and now sits on the stack's internal network — where a
 * compromised API container still reaches it. Without `requirepass`, such a
 * container could PUBLISH into the Socket.IO adapter's channels — a crafted
 * packet delivered to any tenant's rooms — or FLUSHALL the rate-limit
 * counters. The compose file is the only place this is decided, so the test
 * reads it (and compose-stack-render.test.ts renders it as Swarm does).
 */
const compose = readFileSync(
  resolve(process.cwd(), "compose.production.yaml"),
  "utf8",
);

function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `serviço ${name} não encontrado`).toBeGreaterThan(-1);

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\r?\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the production Redis", () => {
  const redis = service("trajetto-redis");

  it("requires a password, and the deploy fails without one", () => {
    expect(redis).toMatch(/REDIS_PASSWORD: \$\{REDIS_PASSWORD:\?[^}]+\}/);
  });

  it("starts with requirepass read inside the container", () => {
    // `$$` so the container's shell reads its own variable: a single `$`
    // would be interpolated by compose into the command line.
    expect(redis).toContain('--requirepass \\"$$REDIS_PASSWORD\\"');
  });

  it("is only called healthy when an authenticated PING answers PONG", () => {
    expect(redis).toMatch(/redis-cli -a \\"\$\$REDIS_PASSWORD\\"[^\n]*grep -q PONG/);
  });
});

describe("the API's connection to it", () => {
  it("carries the password", () => {
    expect(service("api")).toMatch(
      /REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]+\}@\$\{REDIS_HOST\}:\$\{REDIS_PORT\}/,
    );
  });
});

/** The YAML without its comments: what Swarm reads. */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("AI readings in production (ADR 0010, 05/10/2026)", () => {
  /**
   * The readings run in the stack's own trajetto-ai service: no external
   * provider, so no ANTHROPIC_API_KEY anywhere. Optional on the api (`:-`):
   * without the token the readings stay off, as before, and the per-company
   * ai_analysis_limit still gates them.
   */
  it("points the api at the internal service, with no external provider key", () => {
    const api = service("api");

    expect(api).toMatch(/^\s+AI_PROVIDER: \$\{AI_PROVIDER:-local\}\s*$/m);
    expect(api).toMatch(/^\s+AI_LOCAL_URL: http:\/\/trajetto-ai:8080\s*$/m);
    expect(api).toMatch(/^\s+AI_LOCAL_TOKEN: \$\{AI_LOCAL_TOKEN:-\}\s*$/m);
    expect(withoutComments(compose)).not.toMatch(/ANTHROPIC/);
  });

  it("runs the service on the internal network only: no Traefik, no port, no egress", () => {
    const ai = service("trajetto-ai");

    expect(ai).toMatch(/networks:\s*\n\s+- backend\s*\n/);
    expect(ai).not.toMatch(/- edge/);
    expect(withoutComments(ai)).not.toMatch(/traefik/i);
    expect(ai).not.toMatch(/^\s+ports:/m);
  });

  it("gives it nothing it does not need: read-only, no capabilities, no new privileges", () => {
    const ai = service("trajetto-ai");

    expect(ai).toMatch(/^\s+read_only: true\s*$/m);
    expect(ai).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(ai).toMatch(/- no-new-privileges:true/);
    expect(ai).toMatch(/tmpfs:\s*\n\s+- \/tmp/);
  });

  it("refuses to deploy it without the token, and caps its memory and CPU", () => {
    const ai = service("trajetto-ai");

    expect(ai).toMatch(/AI_TOKEN: \$\{AI_LOCAL_TOKEN:\?[^}]+\}/);
    expect(ai).toMatch(/memory: \$\{AI_MEMORY_LIMIT:-1024M\}/);
    expect(ai).toMatch(/cpus: "\$\{AI_CPUS:-2\}"/);
    expect(ai).toMatch(/OCR_THREADS: \$\{AI_CPUS:-2\}/);
    expect(ai).toMatch(/image: ghcr\.io\/trajetto-organization\/trajetto-ai:\$\{AI_IMAGE_TAG:-stable\}/);
  });
});

describe("optional levers the API reads", () => {
  /**
   * Read by the API but never passed to the container: setting them on the
   * stack did nothing. Forwarded as `${VAR:-}`, an unset one arrives empty,
   * and the env loader treats "" as absent, so the defaults still apply.
   */
  it.each([
    "DOCS_USER",
    "DOCS_PASSWORD",
    "PROOF_VERIFICATION_TTL_DAYS",
    "ACTIVITY_RETENTION_DAYS",
  ])("forwards %s, empty when unset", (name) => {
    expect(service("api")).toMatch(
      new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}\\s*$`, "m"),
    );
  });
});

describe("the production Postgres", () => {
  it("gets time to checkpoint before Swarm kills it", () => {
    // The default 10 s can SIGKILL a fast shutdown mid-checkpoint, and every
    // planned restart then pays for crash recovery.
    const grace = service("trajetto-database").match(/stop_grace_period: (\d+)s/);

    expect(grace, "sem stop_grace_period no banco").not.toBeNull();
    expect(Number(grace![1])).toBeGreaterThanOrEqual(60);
  });
});

describe("rolling back through the promote button", () => {
  /**
   * The stack read `latest` and the retag to `stable` only ran behind a
   * STAGING_ENABLED switch, so the `image_tag` typed into the promote button
   * was never used: a rollback to a known-good build showed a green run and
   * redeployed the bad `latest`.
   */
  it("deploys the tag the stack is told to, `stable` by default, never latest", () => {
    expect(service("api")).toMatch(
      /image: ghcr\.io\/trajetto-organization\/trajetto-api:\$\{API_IMAGE_TAG:-stable\}/,
    );
  });

  it("always moves `stable` to the build being promoted", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github", "workflows", "deploy.yml"),
      "utf8",
    );

    const promote = workflow.slice(workflow.indexOf("- name: Promote image to stable"));
    const step = promote.slice(0, promote.indexOf("- name:", 10));

    expect(step).not.toMatch(/if:/);
    // Through `env`, never `${{ }}` inside `run:` (promote-workflow.test.ts).
    expect(step).toContain('trajetto-api:${IMAGE_TAG}"');
  });
});
