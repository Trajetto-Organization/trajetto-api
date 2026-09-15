import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The document an integrator reads before writing a line of code.
 *
 * Swagger is generated from the route declarations, which means it is only as
 * honest as whoever added the last route remembered to be. Two failures
 * matter, and neither breaks anything at runtime:
 *
 *   * a route with no summary, tags or responses is a route nobody outside
 *     this repository can use — it shows up in the page as an empty row;
 *   * a route that requires a token and does not SAY it requires one sends
 *     the integrator to debug a 401 that the document told them not to expect.
 *
 * The second half is the interesting one, and it is asserted as an exact list
 * rather than a count. A new name appearing in it is either a documentation
 * bug or a route that got published by accident, and both deserve a failure
 * that names the route.
 */
let app: Awaited<typeof import("@/http")>["app"];

const VERBS = ["get", "post", "put", "patch", "delete"] as const;

interface Operation {
  summary?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
  security?: unknown[];
}

let operations: Array<{ id: string; operation: Operation }> = [];

/**
 * Everything that may be called with no token at all.
 *
 * Every entry is pre-authentication (you cannot hold a session while asking
 * for a password reset), tokenised by a link we issued (the customer's
 * tracking page), or deliberately public (the event catalogue, the probes).
 */
const ANONYMOUS = [
  "GET /health",
  "GET /health/liveness",
  "GET /health/readiness",
  "GET /integration/v1/catalogue",
  "GET /public/track/{token}",
  "GET /public/verify-proof/{token}",
  "GET /user/forgot-verification",
  "POST /public/track/{token}/opt-out",
  "POST /quote/create-quote",
  "POST /user/email-verification",
  "POST /user/forgot/password",
  "POST /user/refresh-token",
  "POST /user/resend-two-factor-code",
  "POST /user/reset/password",
  "POST /user/session",
  "POST /user/two-factor-verification",
];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/docs/json" });

  expect(response.statusCode, response.body.slice(0, 200)).toBe(200);

  const document = response.json() as {
    paths: Record<string, Record<string, Operation>>;
  };

  operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    VERBS.filter((verb) => methods[verb]).map((verb) => ({
      id: `${verb.toUpperCase()} ${path}`,
      operation: methods[verb],
    })),
  );

  // If the document ever comes back nearly empty, everything below passes
  // vacuously — which is the shape of a test that guards nothing.
  expect(operations.length, "o documento veio vazio").toBeGreaterThan(150);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("every published operation", () => {
  it("says what it does", () => {
    const missing = operations
      .filter(({ operation }) => !operation.summary?.trim())
      .map(({ id }) => id);

    expect(missing, "operações sem summary").toEqual([]);
  });

  it("belongs to a section", () => {
    // Without a tag the operation lands in a nameless group at the bottom of
    // the page, which for a 239-operation document is the same as hiding it.
    const missing = operations
      .filter(({ operation }) => !operation.tags?.length)
      .map(({ id }) => id);

    expect(missing, "operações sem tag").toEqual([]);
  });

  it("describes what comes back", () => {
    const missing = operations
      .filter(
        ({ operation }) => Object.keys(operation.responses ?? {}).length === 0,
      )
      .map(({ id }) => id);

    expect(missing, "operações sem responses").toEqual([]);
  });
});

describe("what can be called without a token", () => {
  it("is exactly the list that is meant to be", () => {
    const anonymous = operations
      .filter(({ operation }) => !operation.security?.length)
      .map(({ id }) => id)
      .sort();

    /**
     * An exact comparison, not a count.
     *
     * A route appearing here is one of two things, and the diff says which:
     * either it needs a token and forgot to declare it — sending an
     * integrator to debug a 401 the document promised would not happen — or it
     * really is reachable with no token, which is a decision somebody should
     * make on purpose rather than discover in production.
     */
    expect(anonymous).toEqual([...ANONYMOUS].sort());
  });
});
