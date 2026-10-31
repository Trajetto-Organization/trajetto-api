import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The deploy step of the API pipeline (staging and production): one call per
 * Dokploy Application (the API and the AI OCR service, each a
 * Docker-provider Application on a GHCR tag). The web runs the same script
 * for its own Application (trajetto-ui/.github/scripts/, kept identical).
 *
 * It was a `curl` to a Portainer webhook, which answers the moment it queues
 * the redeploy: a stack that never converged still finished the run green.
 * The script is run for real here, against a fake Dokploy on the loopback
 * that records every call.
 */
const SCRIPT = resolve(
  process.cwd(),
  ".github",
  "scripts",
  "dokploy-deploy.mjs",
);
const KEY = "dokploy-key-that-must-never-be-printed";

interface Deployment {
  deploymentId: string;
  status: string;
  errorMessage?: string | null;
}

interface Fake {
  url: string;
  calls: Array<{
    method: string;
    path: string;
    key: string | undefined;
    body: string;
  }>;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

/**
 * A Dokploy whose deployment list is `history` until the deploy call, and
 * then walks through `after` one poll at a time (the last one repeats).
 * With `retries`, the Nth extra deploy call walks through `retries[N]`, and
 * the deployments of earlier calls stay in the list with their last state.
 */
async function fakeDokploy(options: {
  history?: Deployment[];
  after?: Deployment[][];
  retries?: Deployment[][][];
  deployStatus?: number;
  /** The first N reads of the deployment list answer 503. */
  listFailures?: number;
  /** The first N reads after the deploy call answer 503. */
  failuresAfterDeploy?: number;
}): Promise<Fake> {
  const calls: Fake["calls"] = [];
  let deployed = false;
  let deploys = 0;
  let polls = 0;
  let listFailures = options.listFailures ?? 0;
  let failuresAfterDeploy = options.failuresAfterDeploy ?? 0;
  const walks = () => [options.after ?? [], ...(options.retries ?? [])];

  server = createServer((request: IncomingMessage, response) => {
    let body = "";

    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const path = request.url ?? "";

      calls.push({
        method: request.method ?? "",
        path,
        key: request.headers["x-api-key"] as string | undefined,
        body,
      });

      response.setHeader("content-type", "application/json");

      if (request.headers["x-api-key"] !== KEY) {
        response.statusCode = 401;
        response.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }

      if (path.startsWith("/api/application.deploy")) {
        response.statusCode = options.deployStatus ?? 200;
        deployed = response.statusCode === 200;
        if (deployed) {
          deploys += 1;
          polls = 0;
        }
        response.end(
          response.statusCode === 200
            ? "true"
            : JSON.stringify({ message: "nope" }),
        );
        return;
      }

      if (path.startsWith("/api/deployment.all?")) {
        if (listFailures > 0 || (deployed && failuresAfterDeploy > 0)) {
          if (listFailures > 0) listFailures -= 1;
          else failuresAfterDeploy -= 1;
          response.statusCode = 503;
          response.end(JSON.stringify({ message: "upstream unavailable" }));
          return;
        }

        const history = options.history ?? [];
        const all = walks();
        const after = all[Math.min(deploys, all.length) - 1] ?? [];
        // Earlier attempts, newest first, as Dokploy lists them.
        const earlier = all
          .slice(0, Math.max(deploys - 1, 0))
          .map((walk) => walk[walk.length - 1] ?? [])
          .reverse()
          .flat();

        if (!deployed || after.length === 0) {
          response.end(JSON.stringify([...earlier, ...history]));
          return;
        }

        const step = after[Math.min(polls, after.length - 1)];

        polls += 1;
        response.end(JSON.stringify([...step, ...earlier, ...history]));
        return;
      }

      response.statusCode = 404;
      response.end("{}");
    });
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    calls,
  };
}

function deploy(env: Record<string, string>) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      // Not the test's own env: nothing of the developer's reaches the script.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        DOKPLOY_POLL_SECONDS: "0.01",
        DOKPLOY_TIMEOUT_SECONDS: "2",
        DOKPLOY_RETRY_SECONDS: "0",
        ...env,
      },
    });

    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

const valid = (fake: Fake) => ({
  DOKPLOY_URL: fake.url,
  DOKPLOY_API_KEY: KEY,
  DOKPLOY_APPLICATION_ID: "abc123_XYZ-9",
});

// Every case starts a Node process and waits for it to exit. Vitest's 5 s
// default is a deadline for that exit, and with the whole unit suite
// saturating the cores two cases missed it on process start-up alone (they
// take ~0.5 s each on their own). The deadline is generous; the waits inside
// the script stay the fast ones the env sets above.
describe("the Dokploy deploy step", { timeout: 30_000 }, () => {
  it("deploys the app it is given and succeeds only when THAT deployment is done", async () => {
    const fake = await fakeDokploy({
      history: [{ deploymentId: "old", status: "done" }],
      after: [
        [],
        [{ deploymentId: "new", status: "running" }],
        [{ deploymentId: "new", status: "done" }],
      ],
    });

    const result = await deploy(valid(fake));

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("new");

    const trigger = fake.calls.find(
      (call) => call.path === "/api/application.deploy",
    );

    expect(trigger?.method).toBe("POST");
    expect(JSON.parse(trigger!.body)).toEqual({
      applicationId: "abc123_XYZ-9",
    });
    expect(fake.calls.every((call) => call.key === KEY)).toBe(true);
  });

  it("does not take the previous deploy's `done` for this one", async () => {
    // The new deployment never leaves `running`: reading "the latest status"
    // would have found the old `done` first and reported success.
    const fake = await fakeDokploy({
      history: [{ deploymentId: "old", status: "done" }],
      after: [[{ deploymentId: "new", status: "running" }]],
    });

    const result = await deploy(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ainda estava 'running'/);
  });

  it("deploys again when a deployment fails, and succeeds when a retry is done", async () => {
    // The staging web deploy of 27/10/2026 failed in Dokploy after 5 s: the
    // image pull from GHCR died with "connection reset by peer" (the VPS's
    // IPv6 route). The same deploy clicked by hand minutes later worked.
    const fake = await fakeDokploy({
      history: [{ deploymentId: "old", status: "done" }],
      after: [[{ deploymentId: "first", status: "error" }]],
      retries: [
        [
          [{ deploymentId: "second", status: "running" }],
          [{ deploymentId: "second", status: "done" }],
        ],
      ],
    });

    const result = await deploy(valid(fake));

    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(
      /::warning::.*first.*'error'.*tentativa 2 de 6/,
    );
    expect(result.output).toContain("second");
    expect(
      fake.calls.filter((call) => call.path === "/api/application.deploy"),
    ).toHaveLength(2);
  });

  it("does not take a failed attempt's deployment for the retry's", async () => {
    // Retry 2 never shows up: the list still holds attempt 1's `error`,
    // which must not be read as the retry ending.
    const fake = await fakeDokploy({
      after: [[{ deploymentId: "first", status: "error" }]],
      retries: [[[]]],
    });

    const result = await deploy({ ...valid(fake), DOKPLOY_ATTEMPTS: "2" });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/não criou o deployment/);
  });

  it("fails after the last attempt ends in error", async () => {
    const failed = (id: string) => [[{ deploymentId: id, status: "error" }]];
    const fake = await fakeDokploy({
      after: failed("a1"),
      retries: [failed("a2"), failed("a3")],
    });

    const result = await deploy({ ...valid(fake), DOKPLOY_ATTEMPTS: "3" });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(
      /a3 de .* terminou em 'error' .* 3 tentativas/,
    );
    expect(
      fake.calls.filter((call) => call.path === "/api/application.deploy"),
    ).toHaveLength(3);
  });

  it("waits twice as long after each failure, up to a ceiling, six times by default", async () => {
    // Run 40551925038 (28/10/2026) failed 3/3 with a fixed 20 s between
    // attempts: every retry landed in the same bad minute of the VPS's IPv6
    // route to GHCR. The defaults are 20, 40, 80, 160, 160 s; here in
    // hundredths so the test takes no time.
    const failed = (id: string) => [[{ deploymentId: id, status: "error" }]];
    const fake = await fakeDokploy({
      after: failed("b1"),
      retries: ["b2", "b3", "b4", "b5", "b6"].map(failed),
    });

    const result = await deploy({
      ...valid(fake),
      DOKPLOY_RETRY_SECONDS: "0.01",
      DOKPLOY_RETRY_MAX_SECONDS: "0.04",
    });

    expect(result.status).toBe(1);
    expect(
      [...result.output.matchAll(/em ([\d.]+)s: tentativa (\d) de 6/g)].map(
        ([, wait, next]) => `${next}:${wait}`,
      ),
    ).toEqual(["2:0.01", "3:0.02", "4:0.04", "5:0.04", "6:0.04"]);
    expect(result.output).toMatch(/b6 de .* depois de 6 tentativas/);
    expect(
      fake.calls.filter((call) => call.path === "/api/application.deploy"),
    ).toHaveLength(6);
  });

  it("logs Dokploy's reason for a failed deployment, on one line and without credentials", async () => {
    // "error" alone sent whoever read the run to the panel to find out it
    // was the pull from GHCR dying midway.
    const fake = await fakeDokploy({
      after: [
        [
          {
            deploymentId: "x1",
            status: "error",
            errorMessage: `Error response from daemon: Get "https://bot:pa55word@ghcr.io/v2/":\nread: connection reset by peer (token=t0k3n, key ${KEY})`,
          },
        ],
      ],
    });

    const result = await deploy({ ...valid(fake), DOKPLOY_ATTEMPTS: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(
      /::error::.*x1.*Motivo informado pelo Dokploy: Error response from daemon: .*read: connection reset by peer/,
    );
    expect(result.output).not.toContain(KEY);
    expect(result.output).not.toContain("pa55word");
    expect(result.output).not.toContain("t0k3n");
  });

  it("says so when Dokploy gives no reason", async () => {
    const fake = await fakeDokploy({
      after: [[{ deploymentId: "y1", status: "error", errorMessage: null }]],
    });

    const result = await deploy({ ...valid(fake), DOKPLOY_ATTEMPTS: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/y1.*não informou o motivo/);
  });

  it("does not retry a deployment someone cancelled", async () => {
    const fake = await fakeDokploy({
      after: [[{ deploymentId: "new", status: "cancelled" }]],
    });

    const result = await deploy(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toContain("'cancelled'");
    expect(
      fake.calls.filter((call) => call.path === "/api/application.deploy"),
    ).toHaveLength(1);
  });

  it("fails when Dokploy refuses the deploy, and does not wait for it", async () => {
    const fake = await fakeDokploy({ deployStatus: 404 });

    const result = await deploy(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/recusou o deploy de .*: HTTP 404/);
    expect(
      fake.calls.filter((call) =>
        call.path.startsWith("/api/application.deploy"),
      ),
    ).toHaveLength(1);
  });

  it("fails when no deployment shows up before the timeout", async () => {
    const fake = await fakeDokploy({
      history: [{ deploymentId: "old", status: "done" }],
    });

    const result = await deploy(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/não criou o deployment/);
  });

  it("only triggers when told not to wait, and says so", async () => {
    const fake = await fakeDokploy({});

    const result = await deploy({ ...valid(fake), DOKPLOY_WAIT: "false" });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/sem acompanhar/);
    expect(fake.calls.map((call) => call.path)).toEqual([
      "/api/application.deploy",
    ]);
  });

  it("never prints the API key", async () => {
    const fake = await fakeDokploy({ deployStatus: 500 });

    const result = await deploy(valid(fake));

    expect(result.output).not.toContain(KEY);
  });

  it("refuses to send the key anywhere but https (loopback aside)", async () => {
    const result = await deploy({
      DOKPLOY_URL: "http://dokploy.example.com",
      DOKPLOY_API_KEY: KEY,
      DOKPLOY_APPLICATION_ID: "abc",
    });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/precisa ser https/);
  });

  it("names what is missing before calling anything", async () => {
    const fake = await fakeDokploy({});

    const result = await deploy({ DOKPLOY_URL: fake.url });

    expect(result.status).toBe(1);
    expect(result.output).toContain("DOKPLOY_API_KEY, DOKPLOY_APPLICATION_ID");
    expect(fake.calls).toEqual([]);
  });

  it("skips an optional Application that has no id yet, without calling Dokploy", async () => {
    const fake = await fakeDokploy({});

    const result = await deploy({
      DOKPLOY_URL: fake.url,
      DOKPLOY_API_KEY: KEY,
      DOKPLOY_APP_LABEL: "trajetto-ai",
      DOKPLOY_OPTIONAL: "true",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("::notice::Deploy de trajetto-ai pulado");
    expect(fake.calls).toEqual([]);
  });

  it("still requires the id of a required Application", async () => {
    const fake = await fakeDokploy({});

    const result = await deploy({
      DOKPLOY_URL: fake.url,
      DOKPLOY_API_KEY: KEY,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("DOKPLOY_APPLICATION_ID");
    expect(fake.calls).toEqual([]);
  });

  /**
   * No retry is silent (CI audit of 30/10/2026): a green run that needed
   * three pulls hid a VPS route going bad again until it failed a deploy.
   */
  describe("retries in the open", () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    const summaryFile = () => {
      dir = mkdtempSync(join(tmpdir(), "dokploy-summary-"));

      const file = join(dir, "summary.md");

      writeFileSync(file, "");

      return file;
    };

    it("warns each request it tries again, with the count, and never the key", async () => {
      // The snapshot before the deploy reads the list: 503 twice, then fine.
      const fake = await fakeDokploy({
        listFailures: 2,
        after: [[{ deploymentId: "new", status: "done" }]],
      });

      const result = await deploy(valid(fake));

      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(
        /::warning::Dokploy: GET \/api\/deployment\.all falhou \(HTTP 503: .*\); tentativa 2 de 3/,
      );
      expect(result.output).toMatch(/tentativa 3 de 3/);
      // The query string (the Application id) stays out of the warning.
      expect(result.output).not.toMatch(/deployment\.all\?applicationId/);
      expect(result.output).not.toContain(KEY);
    });

    it("counts the status checks that failed while it follows a deployment", async () => {
      // After the deploy call, three reads fail: one status check (a request
      // tried three times) gives up, and the next one finds the deployment.
      const fake = await fakeDokploy({
        failuresAfterDeploy: 3,
        after: [[{ deploymentId: "new", status: "done" }]],
      });

      const result = await deploy(valid(fake));

      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(
        /::warning::Falha ao consultar o Dokploy \(HTTP 503: .*\); consulta 1 que falhou nesta tentativa/,
      );
      expect(result.output).toContain("new");
    });

    it("lists every failed attempt and Dokploy's reason in the job summary", async () => {
      const summary = summaryFile();
      const fake = await fakeDokploy({
        after: [
          [
            {
              deploymentId: "first",
              status: "error",
              errorMessage: "pull: read tcp: connection reset by peer",
            },
          ],
        ],
        retries: [
          [
            [
              {
                deploymentId: "second",
                status: "error",
                errorMessage: null,
              },
            ],
          ],
          [[{ deploymentId: "third", status: "done" }]],
        ],
      });

      const result = await deploy({
        ...valid(fake),
        DOKPLOY_APP_LABEL: "trajetto-api",
        GITHUB_STEP_SUMMARY: summary,
      });
      const text = readFileSync(summary, "utf8");

      expect(result.status, result.output).toBe(0);
      expect(text).toMatch(
        /trajetto-api, tentativa 1 de 6 terminou em 'error' \(deployment first\)\. Motivo informado pelo Dokploy: pull: read tcp: connection reset by peer/,
      );
      expect(text).toMatch(
        /trajetto-api, tentativa 2 de 6 terminou em 'error' \(deployment second\)\. O Dokploy não informou o motivo\./,
      );
      expect(text).toMatch(
        /deployment third de trajetto-api concluído na tentativa 3 de 6/,
      );
    });

    it("writes the failed attempts to the summary when it gives up too", async () => {
      const summary = summaryFile();
      const failed = (id: string) => [
        [{ deploymentId: id, status: "error", errorMessage: `reason ${id}` }],
      ];
      const fake = await fakeDokploy({
        after: failed("z1"),
        retries: [failed("z2")],
      });

      const result = await deploy({
        ...valid(fake),
        DOKPLOY_ATTEMPTS: "2",
        GITHUB_STEP_SUMMARY: summary,
      });
      const text = readFileSync(summary, "utf8");

      expect(result.status).toBe(1);
      expect(text).toContain(
        "tentativa 1 de 2 terminou em 'error' (deployment z1)",
      );
      expect(text).toContain("Motivo informado pelo Dokploy: reason z2");
    });
  });
});
