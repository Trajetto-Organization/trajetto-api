import { describe, expect, it, vi } from "vitest";

import {
  readRolloutStatus,
  rolloutToken,
  rolloutTokenMatches,
} from "@/shared/health/rollout-status";

/**
 * GET /health/rollout's gate and answer (plano-escala U-11). The route
 * tells the pipeline which release steps are pending; whoever has no token
 * must not even learn it exists, so a missing, short or wrong token is the
 * same "no" — and the comparison takes the same time whatever was sent.
 * Over HTTP (the 404 identical to an unknown route's):
 * tests/E2E/health-rollout.test.ts.
 */
const TOKEN = "a".repeat(64);

describe("the rollout token", () => {
  it("is closed without a value, or with one shorter than 32 characters", () => {
    expect(rolloutToken(undefined)).toBeNull();
    expect(rolloutToken("")).toBeNull();
    expect(rolloutToken("x".repeat(31))).toBeNull();
    expect(rolloutToken("x".repeat(32))).toBe("x".repeat(32));
  });

  it("matches only the exact bearer", () => {
    expect(rolloutTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(rolloutTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(rolloutTokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(rolloutTokenMatches(`Bearer ${"b".repeat(64)}`, TOKEN)).toBe(false);
    expect(rolloutTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(rolloutTokenMatches("Bearer", TOKEN)).toBe(false);
    expect(rolloutTokenMatches(undefined, TOKEN)).toBe(false);
    expect(rolloutTokenMatches([`Bearer ${TOKEN}`], TOKEN)).toBe(false);
  });

  it("never matches when no token is configured, whatever is sent", () => {
    expect(rolloutTokenMatches("Bearer ", null)).toBe(false);
    expect(rolloutTokenMatches(`Bearer ${TOKEN}`, null)).toBe(false);
  });
});

/**
 * A database whose release_step_state answers `steps` and whose raw reads
 * answer, in order: the live processes (or throw), then the image revision.
 */
function databaseOf(
  steps: unknown[],
  processes: unknown[] | Error = [],
  revision: string | null = null,
) {
  const findMany = vi.fn().mockResolvedValue(steps);
  const queryRaw = vi.fn(
    (strings: TemplateStringsArray, ..._values: unknown[]) =>
      strings.join("?").includes("process_heartbeat")
        ? processes instanceof Error
          ? Promise.reject(processes)
          : Promise.resolve(processes)
        : Promise.resolve([{ revision }]),
  );

  return {
    database: {
      releaseStepState: { findMany },
      $queryRaw: queryRaw,
    } as never,
    findMany,
    queryRaw,
  };
}

const QUEUES = ["outbox", "internal", "external", "webhooks", "ai", "jobs"];

describe("the answer", () => {
  it("lists the pending and failed steps, and when the release step last ran", async () => {
    const at = new Date("2026-11-17T12:00:00.000Z");
    const { database, findMany } = databaseOf([
      { step: "@release", status: "applied", detail: "x", updated_at: at },
      {
        step: "prisma/post-deploy/10-swap.sql",
        status: "pending",
        detail: "esperando a capability",
        updated_at: at,
      },
    ]);

    const status = await readRolloutStatus(database, "abc1234", "staging");

    expect(status.commit).toBe("abc1234");
    expect(status.release).toEqual({
      pending: [
        {
          step: "prisma/post-deploy/10-swap.sql",
          status: "pending",
          detail: "esperando a capability",
          updatedAt: "2026-11-17T12:00:00.000Z",
        },
      ],
      lastRunAt: "2026-11-17T12:00:00.000Z",
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ status: { in: ["pending", "failed"] } }, { step: "@release" }],
      },
      orderBy: { step: "asc" },
    });
  });

  it("has no last run before the first release step", async () => {
    const status = await readRolloutStatus(
      databaseOf([]).database,
      null,
      "production",
    );

    expect(status).toEqual({
      commit: null,
      release: { pending: [], lastRunAt: null },
      roles: {
        appEnv: "production",
        liveWindowSeconds: 90,
        queues: QUEUES,
        processes: [],
      },
      database: { imageRevision: null },
    });
  });
});

/**
 * plano-escala F3-31b: the live processes, for wait-for-roles.mjs. Grouped
 * by everything the deploy compares and counted, never named: the answer
 * carries no hostname, replica or node, so a leaked token maps nothing.
 */
describe("the roles", () => {
  const group = {
    role: "worker",
    app_env: "staging",
    build_commit: "abc1234",
    config_fingerprint: "0123456789abcdef",
    queues: ["outbox", "internal"],
    cron: true,
    sockets: false,
    count: 2,
  };

  it("counts the live processes by role, environment, commit and configuration", async () => {
    const { database, queryRaw } = databaseOf([], [group], "f00dfeed");

    const status = await readRolloutStatus(database, "abc1234", "staging");

    expect(status.roles).toEqual({
      appEnv: "staging",
      liveWindowSeconds: 90,
      queues: QUEUES,
      processes: [
        {
          role: "worker",
          appEnv: "staging",
          commit: "abc1234",
          fingerprint: "0123456789abcdef",
          queues: ["outbox", "internal"],
          cron: true,
          sockets: false,
          count: 2,
        },
      ],
    });
    expect(status.database).toEqual({ imageRevision: "f00dfeed" });

    const read = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");

    expect(read).toContain('"updated_at" > now() - make_interval(secs => ?)');
    expect(queryRaw.mock.calls[0][1]).toBe(90);
    expect(read).not.toContain("replica");
    expect(read).not.toContain("node_hostname");
  });

  it("answers the release half when process_heartbeat cannot be read", async () => {
    const at = new Date("2026-11-17T12:00:00.000Z");
    const { database } = databaseOf(
      [
        {
          step: "infra/sql/10-x.sql",
          status: "failed",
          detail: null,
          updated_at: at,
        },
      ],
      new Error('relation "process_heartbeat" does not exist'),
    );

    const status = await readRolloutStatus(database, "abc1234", "staging");

    expect(status.release.pending).toHaveLength(1);
    expect(status.roles).toBeNull();
  });

  it("reads an empty image revision as none", async () => {
    const status = await readRolloutStatus(
      databaseOf([], [], "").database,
      null,
      "staging",
    );

    expect(status.database.imageRevision).toBeNull();
  });
});
