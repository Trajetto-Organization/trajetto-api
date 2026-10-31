import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The staging deploy's default proof that it shipped, with no SSH key on
 * the host: GET /health/liveness answers the commit the serving image was
 * built from, and .github/scripts/wait-for-version.mjs polls it through the
 * edge until the new commit has answered for longer than Swarm's rollback
 * monitor. Dokploy's `done` only means Swarm ACCEPTED the spec; a rollout
 * Swarm rolls back keeps the old build answering, and staging ran with
 * ROLLOUT_VERIFY=off because the SSH check was the only one there was.
 *
 * Run for real here, against a fake API on the loopback whose answers walk
 * through a list, one request at a time (the last one repeats).
 */
const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, ".github", "scripts", "wait-for-version.mjs");
const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const OLD = "ffffffffffffffffffffffffffffffffffffffff";

type Answer = { status?: number; body?: unknown };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

async function fakeApi(answers: Answer[]) {
  const paths: string[] = [];
  let served = 0;

  server = createServer((request, response) => {
    paths.push(request.url ?? "");

    const answer = answers[Math.min(served, answers.length - 1)];

    served += 1;
    response.statusCode = answer.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(answer.body ?? {}));
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    paths,
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
        ...env,
      },
    });

    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

const alive = (commit: string | null) => ({
  body: {
    status: "alive",
    version: commit ? commit.slice(0, 7) : "dev",
    commit,
  },
});

describe("waiting for the API to serve the deployed build", () => {
  it("passes once the new commit has answered for the whole window", async () => {
    const api = await fakeApi([{ status: 502 }, alive(OLD), alive(SHA)]);

    const result = await wait({ API_URL: api.url, EXPECTED_SHA: SHA });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`responde ${SHA}`);
    // The probe the image's healthcheck uses, never cached on the way.
    expect(
      api.paths.every((path) => path.startsWith("/health/liveness?t=")),
    ).toBe(true);
    expect(new Set(api.paths).size).toBe(api.paths.length);
  });

  it("accepts the 7 characters of `sha-<7>`, which is all a promote knows", async () => {
    const api = await fakeApi([alive(SHA)]);

    const result = await wait({
      API_URL: `${api.url}/some/path`,
      EXPECTED_SHA: SHA.slice(0, 7),
    });

    expect(result.status, result.output).toBe(0);
  });

  it("fails when the old build keeps answering (Swarm rolled the update back)", async () => {
    const api = await fakeApi([alive(OLD)]);

    const result = await wait({ API_URL: api.url, EXPECTED_SHA: SHA });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::error::A API não responde 0a1b2c3/);
    expect(result.output).toContain(`commit ${OLD}`);
  });

  it("starts the window over when an old replica answers inside it", async () => {
    // Two replicas behind the edge: the new one answers, then the old one
    // (still up, or back after a rollback). Never stable, so it fails.
    const api = await fakeApi([
      alive(SHA),
      alive(OLD),
      alive(SHA),
      alive(OLD),
      alive(SHA),
      alive(OLD),
    ]);

    const result = await wait({
      API_URL: api.url,
      EXPECTED_SHA: SHA,
      WAIT_STABLE_SECONDS: "0.5",
      WAIT_TIMEOUT_SECONDS: "0.3",
    });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::warning::A API voltou a responder/);
  });

  it("does not throw the window away on a probe that got no answer", async () => {
    // The edge hiccups (a 502, a 525, a body that is not JSON) inside the
    // window: no replica answered, so nothing says Swarm rolled back. It
    // used to restart the window, as if the old build had answered.
    const flaky = [
      alive(SHA),
      { status: 502 },
      alive(SHA),
      { status: 525 },
      alive(SHA),
      { status: 200, body: "<html>edge error</html>" },
    ];
    const api = await fakeApi([...flaky, ...flaky, ...flaky, alive(SHA)]);

    const result = await wait({
      API_URL: api.url,
      EXPECTED_SHA: SHA,
      WAIT_POLL_SECONDS: "0.02",
      WAIT_STABLE_SECONDS: "0.2",
      WAIT_TIMEOUT_SECONDS: "5",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`responde ${SHA}`);
    // Visible, with the count: a warning per streak, the total in the end.
    expect(result.output).toMatch(
      /::warning::A sondagem de .* não teve resposta \(HTTP 502; falha 1 até agora\)/,
    );
    expect(result.output).toMatch(/\d+ sondagem\(ns\) sem resposta no caminho/);
    expect(result.output).not.toMatch(/voltou a responder HTTP/);
  });

  it("closes the window only on an answer of the new commit, never on failed probes", async () => {
    const api = await fakeApi([alive(SHA), { status: 503 }]);

    const result = await wait({
      API_URL: api.url,
      EXPECTED_SHA: SHA,
      WAIT_STABLE_SECONDS: "0.2",
      WAIT_TIMEOUT_SECONDS: "0.6",
    });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::error::A API responde .* há só \d+s/);
    expect(result.output).toMatch(/sondagem\(ns\) ficaram sem resposta/);
  });

  it("does not take a build with no commit for the new one", async () => {
    const api = await fakeApi([{ body: { status: "alive" } }]);

    const result = await wait({ API_URL: api.url, EXPECTED_SHA: SHA });

    expect(result.status).toBe(1);
    expect(result.output).toContain("sem commit");
  });

  it("refuses what is not a commit or not a URL, before any request", async () => {
    const api = await fakeApi([alive(SHA)]);

    const refused: Array<Record<string, string>> = [
      { API_URL: api.url, EXPECTED_SHA: "staging" },
      { API_URL: api.url, EXPECTED_SHA: "abc12" },
      { API_URL: "not a url", EXPECTED_SHA: SHA },
      { API_URL: "ftp://example.com", EXPECTED_SHA: SHA },
      { EXPECTED_SHA: SHA },
    ];
    // In parallel: five Node processes one after the other outlast the
    // default timeout on a loaded machine.
    const results = await Promise.all(refused.map((env) => wait(env)));

    results.forEach((result, at) =>
      expect(result.status, JSON.stringify(refused[at])).toBe(1),
    );
    expect(api.paths).toEqual([]);
  }, 30_000);

  it("holds the answer for longer than the API Application's rollback monitor", () => {
    // Swarm watches a new task for `Monitor` before it calls the update done
    // (docs/deploy.md, the API Application's Update Config). A shorter window
    // could pass on a task Swarm then rolls back.
    const deploy = readFileSync(resolve(ROOT, "docs", "deploy.md"), "utf8");
    const monitors = [...deploy.matchAll(/"Monitor": (\d+)/g)].map(
      ([, nanoseconds]) => Number(nanoseconds) / 1e9,
    );
    const script = readFileSync(SCRIPT, "utf8");
    const stable = Number(
      script.match(/WAIT_STABLE_SECONDS \|\| (\d+)\)/)?.[1] ?? Number.NaN,
    );

    expect(monitors.length).toBeGreaterThan(0);
    expect(stable).toBeGreaterThan(Math.max(...monitors));
  });
}, 30_000);
