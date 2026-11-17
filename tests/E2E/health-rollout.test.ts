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
 * the 404 of a route that does not exist: whoever probes it learns nothing.
 * With the token: the pending and failed steps and the last run, never
 * cached.
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

describe("GET /health/rollout", () => {
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
    expect(body).toEqual({
      commit: body.commit,
      release: {
        pending: [
          {
            step: "prisma/post-deploy/10-swap.sql",
            status: "pending",
            detail: "esperando a capability",
            updatedAt: "2026-11-17T10:00:00.000Z",
          },
        ],
        lastRunAt: "2026-11-17T10:00:00.000Z",
      },
    });
  });

  it("says nothing is pending before any release step ran", async () => {
    const response = await get("/health/rollout", `Bearer ${TOKEN}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().release).toEqual({ pending: [], lastRunAt: null });
  });
});
