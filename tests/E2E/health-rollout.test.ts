import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * GET /health/rollout over real HTTP (plano-escala U-11): what the release
 * step left in release_step_state, for the pipeline, behind
 * ROLLOUT_STATUS_TOKEN.
 *
 * Without the header, or with a wrong token, the answer is byte for byte
 * the 404 of a route that does not exist, headers included (no
 * `x-ratelimit-*`, never a 429): whoever probes it learns nothing. With the
 * token: the pending and failed steps and the last run, the live processes
 * (F3-31b) and the database's image revision, never cached, at most 30 a
 * minute.
 */
// Before any import reads the environment: it is parsed once.
const TOKEN = vi.hoisted(() => {
  const token = "e2e-rollout-token-0123456789abcdef0123456789abcdef";

  process.env.ROLLOUT_STATUS_TOKEN = token;

  return token;
});

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const get = (url: string, authorization?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: authorization ? { authorization } : {},
  });

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  delete process.env.ROLLOUT_STATUS_TOKEN;

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

beforeEach(async () => {
  await prisma.releaseStepState.deleteMany();
});

/** The 404 of a path nobody registered, for the same method. */
async function unknownRoute() {
  const response = await get("/health/rollout-nothing-here");

  return {
    status: response.statusCode,
    code: response.headers["x-error-code"],
    body: response.json(),
  };
}

/**
 * A missing path of the same length (so the same content-length), and the
 * headers whose values change from one call to the next (the date, a
 * request id): only their presence can be compared.
 */
const SAME_LENGTH_UNKNOWN = "/health/rolloux";

async function unknownHeaders() {
  const first = await get(SAME_LENGTH_UNKNOWN);
  const second = await get(SAME_LENGTH_UNKNOWN);
  const volatile = new Set(
    Object.keys(first.headers).filter(
      (name) => first.headers[name] !== second.headers[name],
    ),
  );

  return { headers: second.headers, volatile };
}

describe("GET /health/rollout", () => {
  it("carries the same headers as a missing path, the limiter's included", async () => {
    const response = await get(
      "/health/rollout",
      "Bearer e2e-wrong-token-0123456789abcdef0123456789abcd",
    );
    const unknown = await unknownHeaders();

    expect(response.statusCode).toBe(404);
    expect(Object.keys(response.headers).sort()).toEqual(
      Object.keys(unknown.headers).sort(),
    );
    for (const [name, value] of Object.entries(unknown.headers)) {
      if (unknown.volatile.has(name)) continue;
      expect(response.headers[name], name).toEqual(value);
    }
    expect(
      Object.keys(response.headers).filter((name) =>
        name.startsWith("x-ratelimit"),
      ),
    ).toEqual([]);
  });

  it("never turns a probe without the token into a 429", async () => {
    const statuses = new Set<number>();

    for (let probe = 0; probe < 35; probe += 1) {
      statuses.add((await get("/health/rollout")).statusCode);
    }

    expect([...statuses]).toEqual([404]);
  });

  it("counts the requests that carry the token, at most 30 a minute", async () => {
    const first = await get("/health/rollout", `Bearer ${TOKEN}`);
    const second = await get("/health/rollout", `Bearer ${TOKEN}`);

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-limit"]).toBe("30");
    expect(Number(second.headers["x-ratelimit-remaining"])).toBe(
      Number(first.headers["x-ratelimit-remaining"]) - 1,
    );
  });

  it.each([
    ["without a token", undefined],
    [
      "with a wrong token",
      "Bearer e2e-wrong-token-0123456789abcdef0123456789abcd",
    ],
    ["with the token in another scheme", `Basic ${TOKEN}`],
  ])(
    "answers %s exactly as a route that does not exist",
    async (_case, header) => {
      const response = await get("/health/rollout", header);
      const unknown = await unknownRoute();

      expect(response.statusCode).toBe(404);
      expect(response.headers["x-error-code"]).toBe(unknown.code);
      expect(response.json()).toEqual({
        ...unknown.body,
        message: "Route GET:/health/rollout not found",
      });
      expect(unknown.body.message).toBe(
        "Route GET:/health/rollout-nothing-here not found",
      );
    },
  );

  it("lists the pending and failed steps and the last run, never cached", async () => {
    const at = new Date("2026-11-17T10:00:00.000Z");

    await prisma.releaseStepState.createMany({
      data: [
        {
          step: "@release",
          status: "applied",
          detail: "1 pendentes",
          updated_at: at,
        },
        {
          step: "infra/sql/10-roles.sql",
          status: "skipped",
          detail: "já feito",
          updated_at: at,
        },
        {
          step: "prisma/post-deploy/10-swap.sql",
          status: "pending",
          detail: "esperando a capability",
          updated_at: at,
        },
        {
          step: "prisma/post-deploy/20-old.sql",
          status: "retired",
          detail: null,
          updated_at: at,
        },
      ],
    });

    const response = await get("/health/rollout", `Bearer ${TOKEN}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();

    // A local build has no commit (build-info.ts); a CI one has it.
    expect(body.commit === null || typeof body.commit === "string").toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      "commit",
      "database",
      "release",
      "roles",
    ]);
    expect(body.release).toEqual({
      pending: [
        {
          step: "prisma/post-deploy/10-swap.sql",
          status: "pending",
          detail: "esperando a capability",
          updatedAt: "2026-11-17T10:00:00.000Z",
        },
      ],
      lastRunAt: "2026-11-17T10:00:00.000Z",
    });
  });

  it("says nothing is pending before any release step ran", async () => {
    const response = await get("/health/rollout", `Bearer ${TOKEN}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().release).toEqual({ pending: [], lastRunAt: null });
  });
});

/**
 * plano-escala F3-31b: the live processes, from process_heartbeat, for the
 * deploy's wait-for-roles.mjs. Grouped and counted by role, environment,
 * commit, fingerprint, queues, cron and sockets; a row out of the live
 * window does not count; and no hostname, replica or node ever leaves.
 */
describe("GET /health/rollout, the roles", () => {
  const COMMIT = `e2e-roles-${Date.now().toString(36)}`;
  const REPLICAS = [1, 2, 3, 4].map((n) => `wfl-roles-host-${n}-${COMMIT}`);
  const NODE = `wfl-roles-node-${COMMIT}`;

  afterAll(async () => {
    await prisma.processHeartbeat.deleteMany({
      where: { replica: { in: REPLICAS } },
    });
  });

  it("counts the live processes by what the deploy compares, never by host", async () => {
    const row = (replica: string, extra: Record<string, unknown>) => ({
      replica,
      role: "worker",
      app_env: "staging",
      build_commit: COMMIT,
      config_fingerprint: "0123456789abcdef",
      node_hostname: NODE,
      queues: ["outbox", "internal"],
      cron: true,
      sockets: false,
      started_at: new Date(),
      ...extra,
    });

    await prisma.processHeartbeat.createMany({
      data: [
        row(REPLICAS[0], {}),
        row(REPLICAS[1], {}),
        row(REPLICAS[2], {
          role: "api",
          queues: [],
          cron: false,
          sockets: true,
        }),
        // Stopped beating two minutes ago: no longer a live process.
        row(REPLICAS[3], { updated_at: new Date(Date.now() - 120_000) }),
      ],
    });

    const response = await get("/health/rollout", `Bearer ${TOKEN}`);

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const ours = body.roles.processes.filter(
      (group: { commit: string | null }) => group.commit === COMMIT,
    );

    expect(body.roles).toMatchObject({
      liveWindowSeconds: 90,
      queues: ["outbox", "internal", "external", "webhooks", "ai", "jobs"],
    });
    expect(typeof body.roles.appEnv).toBe("string");
    expect(ours).toEqual([
      {
        role: "api",
        appEnv: "staging",
        commit: COMMIT,
        fingerprint: "0123456789abcdef",
        queues: [],
        cron: false,
        sockets: true,
        count: 1,
      },
      {
        role: "worker",
        appEnv: "staging",
        commit: COMMIT,
        fingerprint: "0123456789abcdef",
        queues: ["outbox", "internal"],
        cron: true,
        sockets: false,
        count: 2,
      },
    ]);

    const raw = response.body;

    for (const name of [...REPLICAS, NODE]) expect(raw).not.toContain(name);

    // The stock postgres image carries no revision; trajetto-postgres
    // carries its commit (or `dev`).
    expect(Object.keys(body.database)).toEqual(["imageRevision"]);
    expect(
      body.database.imageRevision === null ||
        /^[0-9A-Za-z._-]{1,64}$/.test(body.database.imageRevision),
    ).toBe(true);
  });
});
