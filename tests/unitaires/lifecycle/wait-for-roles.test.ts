import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  conditionOf,
  jobOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
} from "./support/workflow-text";

/**
 * The deploy waits for every role, not only the API (plano-escala F3-31b).
 *
 * With the worker as its own Application, a worker whose new task failed
 * its healthcheck is rolled back by Swarm, the old one keeps claiming the
 * queues on the old build, and the API's liveness — the only check there
 * was — answers the new commit: a green run with half the environment
 * behind. .github/scripts/wait-for-roles.mjs reads GET /health/rollout's
 * live processes and waits until each expected role runs the deployed
 * commit, every queue has a consumer, some process runs the cron and every
 * process shares one configuration fingerprint. The role `all` covers api,
 * worker and scheduler (D22): production expects `all` until its worker
 * exists, and a promotion between waves 12 and 14 must stay green.
 *
 * Run for real against a fake API on the loopback whose answers walk
 * through a list, one request at a time (the last one repeats).
 */
const SCRIPT = resolve(
  process.cwd(),
  ".github",
  "scripts",
  "wait-for-roles.mjs",
);
const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const OLD = "ffffffffffffffffffffffffffffffffffffffff";
const TOKEN = "t".repeat(64);
const PRINT = "0123456789abcdef";
const QUEUES = ["outbox", "internal", "external", "webhooks", "ai", "jobs"];

type Answer = { status?: number; body?: unknown };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

async function fakeApi(answers: Answer[]) {
  const requests: Array<{ path: string; authorization?: string }> = [];

  server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
    });

    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];

    response.statusCode = answer.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(answer.body ?? {}));
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    requests,
  };
}

function wait(env: Record<string, string>) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        WAIT_POLL_SECONDS: "0.01",
        WAIT_STABLE_SECONDS: "0.05",
        WAIT_TIMEOUT_SECONDS: "1",
        ROLLOUT_STATUS_TOKEN: TOKEN,
        EXPECTED_SHA: SHA,
        ...env,
      },
    });

    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

interface Group {
  role: string;
  appEnv?: string;
  commit?: string | null;
  fingerprint?: string | null;
  queues?: string[];
  cron?: boolean;
  sockets?: boolean;
  count?: number;
}

const process_ = (group: Group) => ({
  appEnv: "staging",
  commit: SHA,
  fingerprint: PRINT,
  queues: [],
  cron: false,
  sockets: false,
  count: 1,
  ...group,
});

const api = (extra: Partial<Group> = {}) =>
  process_({ role: "api", sockets: true, count: 2, ...extra });
const worker = (extra: Partial<Group> = {}) =>
  process_({ role: "worker", queues: QUEUES, cron: true, ...extra });
const all = (extra: Partial<Group> = {}) =>
  process_({
    role: "all",
    queues: QUEUES,
    cron: true,
    sockets: true,
    count: 2,
    ...extra,
  });

const rollout = (processes: unknown[], commit: string | null = SHA) => ({
  body: {
    commit,
    release: { pending: [], lastRunAt: null },
    roles: {
      appEnv: "staging",
      liveWindowSeconds: 90,
      queues: QUEUES,
      processes,
    },
    database: { imageRevision: null },
  },
});

describe("waiting for every role to run the deployed build", () => {
  it("passes once the expected roles hold the new commit for the whole window", async () => {
    const fake = await fakeApi([
      rollout([api(), worker({ commit: OLD })]),
      rollout([api(), worker()]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`api,worker em ${SHA}`);
    expect(result.output).toContain("worker×1");
    // The token in the header, never in the URL.
    expect(
      fake.requests.every(
        (request) =>
          request.path === "/health/rollout" &&
          request.authorization === `Bearer ${TOKEN}`,
      ),
    ).toBe(true);
    expect(result.output).not.toContain(TOKEN);
  });

  it("takes a process in `all` for the api and the worker (production until wave 14)", async () => {
    const fake = await fakeApi([rollout([all()])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status, result.output).toBe(0);
  });

  it("expects api, worker and scheduler from `all`", async () => {
    const passes = await wait({
      API_URL: (await fakeApi([rollout([all()])])).url,
      ROLLOUT_ROLES_EXPECTED: "all",
    });

    expect(passes.status, passes.output).toBe(0);

    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;

    const fails = await wait({
      API_URL: (await fakeApi([rollout([api(), worker()])])).url,
      ROLLOUT_ROLES_EXPECTED: "all",
    });

    expect(fails.status).not.toBe(0);
    expect(fails.output).toContain(
      "nenhum processo vivo cobre o papel scheduler",
    );
  });

  it("fails when the worker never comes up on the new commit (Swarm rolled it back)", async () => {
    const fake = await fakeApi([rollout([api(), worker({ commit: OLD })])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "1 processo(s) worker ainda em ffffffffffff",
    );
    expect(result.output).toContain(
      "nenhum processo vivo cobre o papel worker no commit novo",
    );
  });

  it("fails when the worker is missing altogether", async () => {
    const fake = await fakeApi([rollout([api()])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("fila(s) sem consumidor no commit novo");
    expect(result.output).toContain(
      "nenhum processo no commit novo roda o cron",
    );
  });

  it("fails when the Environments of the Applications diverge", async () => {
    const fake = await fakeApi([
      rollout([api(), worker({ fingerprint: "fedcba9876543210" })]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("2 impressões de configuração diferentes");
  });

  it("fails while a process of the other environment uses this database", async () => {
    const fake = await fakeApi([
      rollout([
        api(),
        worker(),
        worker({ appEnv: "production", fingerprint: "fedcba9876543210" }),
      ]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "1 processo(s) worker de outro ambiente (APP_ENV=production) neste banco",
    );
  });

  it("fails when a queue has no consumer on the new commit", async () => {
    const fake = await fakeApi([
      rollout([
        api(),
        worker({ queues: ["outbox", "internal", "webhooks", "ai", "jobs"] }),
      ]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "fila(s) sem consumidor no commit novo: external",
    );
  });

  it("waits while a process has not read its fingerprint yet", async () => {
    const fake = await fakeApi([
      rollout([api(), worker({ fingerprint: null })]),
      rollout([api(), worker()]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("ainda sem a impressão da configuração");
  });

  it("restarts the window when a role leaves the new commit inside it", async () => {
    const fake = await fakeApi([
      rollout([api(), worker()]),
      rollout([api(), worker({ commit: OLD })]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
      WAIT_STABLE_SECONDS: "0.5",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("::warning::Os papéis deixaram de estar");
  });

  it("keeps waiting through answers that say nothing, and an older replica", async () => {
    const fake = await fakeApi([
      { status: 502 },
      { status: 429 },
      { body: { commit: OLD, release: { pending: [], lastRunAt: null } } },
      rollout([api(), worker()]),
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("sem resposta (HTTP 502)");
  });

  it("waits while the API cannot read process_heartbeat", async () => {
    const fake = await fakeApi([
      { body: { ...rollout([]).body, roles: null } },
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("a API não leu o process_heartbeat");
  });

  /**
   * The realtime held on its build by this deploy (plano-escala F3-31c):
   * its code did not change, so it was not deployed, and its processes
   * run the previous commit on purpose. Alive is all it owes the check.
   */
  describe("with a role held on its build (ROLLOUT_ROLES_HELD)", () => {
    const realtime = (extra: Partial<Group> = {}) =>
      process_({ role: "realtime", sockets: true, commit: OLD, ...extra });

    it("accepts it on its previous commit", async () => {
      const fake = await fakeApi([rollout([api(), worker(), realtime()])]);

      const result = await wait({
        API_URL: fake.url,
        ROLLOUT_ROLES_EXPECTED: "api,worker,realtime",
        ROLLOUT_ROLES_HELD: "realtime",
      });

      expect(result.status, result.output).toBe(0);
    });

    it("still fails a realtime on an old commit that was not held", async () => {
      const fake = await fakeApi([rollout([api(), worker(), realtime()])]);

      const result = await wait({
        API_URL: fake.url,
        ROLLOUT_ROLES_EXPECTED: "api,worker,realtime",
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("processo(s) realtime ainda em");
    });

    it("still needs it alive", async () => {
      const fake = await fakeApi([rollout([api(), worker()])]);

      const result = await wait({
        API_URL: fake.url,
        ROLLOUT_ROLES_EXPECTED: "api,worker,realtime",
        ROLLOUT_ROLES_HELD: "realtime",
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "nenhum processo vivo do papel realtime (mantido no build dele)",
      );
    });

    it("holds nothing for another role's old commit", async () => {
      const fake = await fakeApi([
        rollout([api(), worker({ commit: OLD }), realtime()]),
      ]);

      const result = await wait({
        API_URL: fake.url,
        ROLLOUT_ROLES_EXPECTED: "api,worker,realtime",
        ROLLOUT_ROLES_HELD: "realtime",
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("processo(s) worker ainda em");
    });
  });
});

/**
 * The same wait for the roles a deploy has just shipped, before the API's
 * turn (WAIT_ROLES_SCOPE=roles, review of wave 12). Without SSH there was
 * no check of the worker until the API had shipped on top of it; here the
 * API answering is still the previous build, so only the listed roles are
 * judged.
 */
describe("waiting for the roles deployed before the API", () => {
  const before = (fakeUrl: string, roles = "worker") =>
    wait({
      API_URL: fakeUrl,
      ROLLOUT_ROLES_EXPECTED: roles,
      WAIT_ROLES_SCOPE: "roles",
    });

  it("passes on the roles alone, the API still on the previous build", async () => {
    // The old API, with its own fingerprint and none of the queues, would
    // keep the whole environment's wait from converging.
    const fake = await fakeApi([
      rollout(
        [
          all({ commit: OLD, fingerprint: "fedcba9876543210", queues: [] }),
          worker({ commit: OLD }),
        ],
        OLD,
      ),
      rollout(
        [
          all({ commit: OLD, fingerprint: "fedcba9876543210", queues: [] }),
          worker(),
        ],
        OLD,
      ),
    ]);

    const result = await before(fake.url);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`Papéis antes da API: worker em ${SHA}`);
  });

  it("fails, saying the API was not deployed, when the worker never comes up", async () => {
    const fake = await fakeApi([
      rollout([api({ commit: OLD }), worker({ commit: OLD })], OLD),
    ]);

    const result = await before(fake.url);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "nenhum processo vivo do papel worker no commit novo",
    );
    expect(result.output).toContain("1 processo(s) worker ainda em");
    expect(result.output).toContain("A API não foi implantada");
  });

  it("does not take the API's `all` for a worker", async () => {
    const fake = await fakeApi([rollout([all()])]);

    const result = await before(fake.url);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "nenhum processo vivo do papel worker no commit novo",
    );
  });

  it("steps aside when the API is too old to list the processes, whatever commit it answers", async () => {
    const fake = await fakeApi([
      { body: { commit: OLD, release: { pending: [], lastRunAt: null } } },
    ]);

    const result = await before(fake.url);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::notice::");
    expect(result.output).toContain("anterior à conferência por papel");
  });

  it("refuses a scope it does not know", async () => {
    const fake = await fakeApi([rollout([worker()])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "worker",
      WAIT_ROLES_SCOPE: "some",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("WAIT_ROLES_SCOPE");
  });
});

describe("what makes it step aside", () => {
  it.each([
    ["without the token", { ROLLOUT_STATUS_TOKEN: "" }, "ROLLOUT_STATUS_TOKEN"],
    [
      "without ROLLOUT_ROLES_EXPECTED",
      { ROLLOUT_ROLES_EXPECTED: "" },
      "ROLLOUT_ROLES_EXPECTED",
    ],
  ])("does not run %s, and asks nothing", async (_case, env, name) => {
    const fake = await fakeApi([rollout([])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "api,worker",
      ...env,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::notice::");
    expect(result.output).toContain(name);
    expect(fake.requests).toEqual([]);
  });

  it("skips a build older than the roles once it answers the expected commit", async () => {
    const fake = await fakeApi([
      { body: { commit: SHA, release: { pending: [], lastRunAt: null } } },
    ]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "all",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("anterior à conferência por papel");
  });

  it("skips with a warning after three 404s in a row (no route, or another token)", async () => {
    const fake = await fakeApi([{ status: 404 }]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "all",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::warning::");
    expect(fake.requests).toHaveLength(3);
  });

  it.each([
    ["an unknown role", { ROLLOUT_ROLES_EXPECTED: "api,ui" }, "ui"],
    ["only commas", { ROLLOUT_ROLES_EXPECTED: " , " }, "nenhum papel"],
    ["plain http off the loopback", { API_URL: "http://example.com" }, "https"],
    ["a sha that is not one", { EXPECTED_SHA: "staging" }, "EXPECTED_SHA"],
  ])("refuses %s", async (_case, env, says) => {
    const fake = await fakeApi([rollout([all()])]);

    const result = await wait({
      API_URL: fake.url,
      ROLLOUT_ROLES_EXPECTED: "all",
      ...env,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::");
    expect(result.output).toContain(says);
  });
});

describe("the deploy action", () => {
  const deploy = readAction("deploy");
  const STEP = "Wait for every role to run this build";
  const at = (name: string) => stepNames(deploy).indexOf(name);

  it("runs after the edge roles and before the tags follow and the marker", () => {
    expect(at(STEP)).toBeGreaterThan(at("Deploy the edge roles (Dokploy)"));
    expect(at(STEP)).toBeLessThan(
      at("Move the tags of the roles not deployed"),
    );
    expect(at(STEP)).toBeLessThan(at("Mark this build as staged"));
  });

  it("runs with Dokploy, unless ROLLOUT_VERIFY=off, with the environment's values", () => {
    const step = stepOf(deploy, STEP);

    expect(conditionOf(step)).toBe(
      "steps.head.outputs.current == 'true' && steps.dokploy.outputs.enabled == 'true' && steps.verify.outputs.mode != 'off'",
    );
    for (const line of [
      "API_URL: ${{ inputs.api-public-url }}",
      "ROLLOUT_STATUS_TOKEN: ${{ inputs.rollout-status-token }}",
      "ROLLOUT_ROLES_EXPECTED: ${{ inputs.rollout-roles-expected }}",
      "EXPECTED_SHA: ${{ inputs.expected-commit }}",
      "node .github/scripts/wait-for-roles.mjs",
    ]) {
      expect(step.text).toContain(line);
    }
  });

  it.each([
    ["staging.yml", "deploy-staging"],
    ["production.yml", "promote-production"],
  ] as const)(
    "%s hands it the environment's ROLLOUT_ROLES_EXPECTED",
    (workflow, job) => {
      expect(jobOf(readWorkflow(workflow), job).text).toContain(
        "rollout-roles-expected: ${{ vars.ROLLOUT_ROLES_EXPECTED }}",
      );
      expect(deploy.text).toContain("  rollout-roles-expected:");
    },
  );
});
