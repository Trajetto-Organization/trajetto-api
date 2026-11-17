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

describe("the answer", () => {
  it("lists the pending and failed steps, and when the release step last ran", async () => {
    const at = new Date("2026-11-17T12:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      { step: "@release", status: "applied", detail: "x", updated_at: at },
      {
        step: "prisma/post-deploy/10-swap.sql",
        status: "pending",
        detail: "esperando a capability",
        updated_at: at,
      },
    ]);

    const status = await readRolloutStatus(
      { releaseStepState: { findMany } } as never,
      "abc1234",
    );

    expect(status).toEqual({
      commit: "abc1234",
      release: {
        pending: [
          {
            step: "prisma/post-deploy/10-swap.sql",
            status: "pending",
            detail: "esperando a capability",
            updatedAt: "2026-11-17T12:00:00.000Z",
          },
        ],
        lastRunAt: "2026-11-17T12:00:00.000Z",
      },
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
      { releaseStepState: { findMany: async () => [] } } as never,
      null,
    );

    expect(status).toEqual({
      commit: null,
      release: { pending: [], lastRunAt: null },
    });
  });
});
