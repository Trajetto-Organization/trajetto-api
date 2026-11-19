import { sign } from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * A list past its limit is refused as ONE issue, before any element is read
 * (GHSA-mrhx-c7xc-m3w5, zod < 4.6.6).
 *
 * zod 3 marked the `.max()` failure and went on validating every element,
 * and the error handler answers (and logs) every issue. Measured on the
 * import-xml body, whose cap is 25 files under a 13 MiB body limit: 1.9 MiB
 * made 1,000,001 issues and +282 MiB of heap, and ~7 MB under the
 * production --max-old-space-size=768 killed the replica — one request, from
 * any user allowed to import. zod 4.6.6 stops at a leading size check.
 *
 * Through the real route: the session check is the real middleware over
 * stand-in repositories, so the refusal comes from the route's own body
 * validation and the global error handler, as in production. No database.
 */

const BUSINESS = "0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

const repositories = vi.hoisted(() => ({
  findUserById: vi.fn(),
  hasActiveRefreshTokenFamily: vi.fn(),
}));

// The one-statement session lookup (SESSION_LOOKUP_MODE=single, the
// default) answers from the same stand-ins the old path reads.
vi.mock("@/modules/user/repositories/session-repository", () => ({
  SessionRepository: class {
    async loadSession(userId: string, familyId: string) {
      const user = await repositories.findUserById(userId);

      return {
        user,
        hasActiveFamily: user
          ? await repositories.hasActiveRefreshTokenFamily(userId, familyId)
          : false,
      };
    }
  },
}));

vi.mock("@/modules/user/repositories/user-repository", async (original) => {
  const actual =
    await original<
      typeof import("@/modules/user/repositories/user-repository")
    >();

  return {
    ...actual,
    UserRepository: class extends actual.UserRepository {
      findUserById = repositories.findUserById;
    },
  };
});

vi.mock(
  "@/modules/user/repositories/user-tokens-repository",
  async (original) => {
    const actual =
      await original<
        typeof import("@/modules/user/repositories/user-tokens-repository")
      >();

    return {
      ...actual,
      UserTokensRepository: class extends actual.UserTokensRepository {
        hasActiveRefreshTokenFamily = repositories.hasActiveRefreshTokenFamily;
      },
    };
  },
);

type App = Awaited<typeof import("@/http")>["app"];

let app: App;
let authorization: string;

beforeAll(async () => {
  const { default: auth } = await import("@/config/auth");

  repositories.findUserById.mockResolvedValue({
    id: "user-1",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
    session_version: 1,
    access_revoked: false,
    driverId: null,
    profileAccess: null,
    business: {
      id: BUSINESS,
      is_active: true,
      entitlements: [{ module: "DELIVERIES", enabled: true }],
    },
  });
  repositories.hasActiveRefreshTokenFamily.mockResolvedValue(true);

  authorization = `Bearer ${sign(
    {
      sub: "user-1",
      tokenType: "access",
      sessionVersion: 1,
      familyId: "family-1",
    },
    auth.secret_token,
  )}`;

  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const importXml = (files: unknown[]) =>
  app.inject({
    method: "POST",
    url: `/delivery/import-xml/${BUSINESS}`,
    headers: { authorization, "content-type": "application/json" },
    payload: JSON.stringify({ files, scheduled_date: "2026-11-10" }),
  });

describe("POST /delivery/import-xml with a list past its cap", () => {
  it("answers one issue for 200,000 files (~7 MB), not one per file", async () => {
    const files = Array.from({ length: 200_000 }, () => ({
      filename: "nota.xml",
      // Empty: each element is itself invalid, so zod 3 reported 200,000
      // more issues on top of the size one.
      content: "",
    }));

    const response = await importXml(files);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      code: "VALIDATION_ERROR",
      message: "Envie no máximo 25 arquivos por vez.",
      issues: ["Envie no máximo 25 arquivos por vez."],
    });
  });

  it("still names each refused file when the list is within its cap", async () => {
    const response = await importXml([
      { filename: "a.xml", content: "" },
      { filename: "b.xml", content: "" },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toEqual([
      "O conteúdo do arquivo não pode estar vazio.",
      "O conteúdo do arquivo não pode estar vazio.",
    ]);
  });
});

describe("the public create's item list", () => {
  it("is refused as one issue past 200 items", async () => {
    const { parseIntegrationDeliveryBody } =
      await import("@/schemas/create-integration-delivery-schema");
    const { ZodError } = await import("zod");

    let issues: string[] = [];

    try {
      parseIntegrationDeliveryBody({
        items: Array.from({ length: 200_000 }, () => ({ unitValue: 1 })),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      issues = (error as InstanceType<typeof ZodError>).issues.map(
        (issue) => issue.message,
      );
    }

    expect(issues.filter((issue) => issue.startsWith("items"))).toEqual([
      "items: Uma entrega não pode ter mais de 200 itens.",
    ]);
  });
});
