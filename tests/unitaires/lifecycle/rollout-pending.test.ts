import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * .github/scripts/rollout-pending.mjs, run for real against a fake API on
 * the loopback (plano-escala U-11): the deploy's "Decide migrations" runs
 * the release step again when it prints a pending step. It must say
 * "cannot tell" (exit 1) rather than "nothing pending" whenever it did not
 * read an answer — an old API without the route, a token that differs, no
 * URL — and never print the token.
 */
const SCRIPT = resolve(process.cwd(), ".github/scripts/rollout-pending.mjs");
const TOKEN = "pipeline-token-that-must-never-be-printed-0123456789";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

async function fakeApi(
  answer: (authorization: string | undefined) => {
    status: number;
    body: unknown;
  },
) {
  server = createServer((request, response) => {
    const { status, body } = answer(request.headers.authorization);

    response.statusCode = request.url === "/health/rollout" ? status : 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function pending(env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ROLLOUT_TIMEOUT_SECONDS: "2",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => done({ status, stdout, stderr }));
    },
  );
}

const ANSWER = {
  commit: "abc",
  release: {
    pending: [
      { step: "prisma/post-deploy/10-swap.sql", status: "pending" },
      { step: "infra/sql/10-partitions.sql", status: "failed" },
    ],
    lastRunAt: null,
  },
};

describe("the pending steps, read", { timeout: 30_000 }, () => {
  it("prints the pending and failed steps, sending the token as a bearer", async () => {
    const url = await fakeApi((authorization) =>
      authorization === `Bearer ${TOKEN}`
        ? { status: 200, body: ANSWER }
        : { status: 404, body: {} },
    );

    const result = await pending({ API_URL: url, ROLLOUT_STATUS_TOKEN: TOKEN });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "prisma/post-deploy/10-swap.sql, infra/sql/10-partitions.sql",
    );
  });

  it("prints nothing when nothing is pending", async () => {
    const url = await fakeApi(() => ({
      status: 200,
      body: { commit: "abc", release: { pending: [], lastRunAt: null } },
    }));

    const result = await pending({ API_URL: url, ROLLOUT_STATUS_TOKEN: TOKEN });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("cannot tell on a 404 (an API from before the route, or another token), and says why", async () => {
    const url = await fakeApi(() => ({ status: 404, body: {} }));

    const result = await pending({ API_URL: url, ROLLOUT_STATUS_TOKEN: TOKEN });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("respondeu 404");
    expect(result.stderr + result.stdout).not.toContain(TOKEN);
  });

  it("cannot tell on an answer without the list", async () => {
    const url = await fakeApi(() => ({ status: 200, body: { commit: "abc" } }));

    const result = await pending({ API_URL: url, ROLLOUT_STATUS_TOKEN: TOKEN });

    expect(result.status).toBe(1);
  });

  it.each([
    ["no URL", { ROLLOUT_STATUS_TOKEN: TOKEN }],
    [
      "plain http outside the loopback",
      { API_URL: "http://api.example.com", ROLLOUT_STATUS_TOKEN: TOKEN },
    ],
    ["no token", { API_URL: "https://api.example.com" }],
  ])("cannot tell with %s, before any request", async (_case, env) => {
    const result = await pending(env as Record<string, string>);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
