import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * GET /config/map (wave 5) over real HTTP: the base map the app's live map
 * draws, from the web's four MAP_TILE_* variables. Any session reads it (a
 * manager, a driver, a MASTER with no company): it is the platform's
 * provider, not a company's data, so every caller gets the same answer and a
 * company the MASTER names changes nothing; another company named by anyone
 * else meets the global tenant guard, as on every route. Without a session,
 * 401. The
 * credit leaves escaped, the dark style falls back to the light credit, and
 * the answer is cached privately for a short while (the URL may carry the
 * provider's key). The rules case by case are in tests/unitaires/map/.
 */
// Before any import: the env is parsed once, when `@/env` first loads, and
// the seed helper loads it through `@/config/auth`.
const TILES = vi.hoisted(() => {
  const tiles = {
    url: "https://{s}.tiles.example.test/light/{z}/{x}/{y}.png?key=e2e-tile-key",
    attribution: "© Exemplo & <Mapas>",
    darkUrl: "https://dark.example.test/{z}/{x}/{y}.png?key=e2e-tile-key",
  };

  process.env.MAP_TILE_URL = tiles.url;
  process.env.MAP_TILE_ATTRIBUTION = tiles.attribution;
  process.env.MAP_TILE_URL_DARK = tiles.darkUrl;
  // Empty, not deleted: dotenv never overrides a variable that exists, so a
  // local .env cannot give the dark style a credit of its own here.
  process.env.MAP_TILE_ATTRIBUTION_DARK = "";

  return tiles;
});

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const BUSINESS = "018fea50-0000-7000-8000-00000000000a";
const OTHER = "018fea50-0000-7000-8000-00000000000b";

const tokens = { manager: "", driver: "", master: "" };

const ESCAPED = "© Exemplo &amp; &lt;Mapas&gt;";

const get = (url: string, token?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

async function seedMaster(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Master",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "MASTER",
      businessId: null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "30m" },
  );
}

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "41555666000171",
  });

  tokens.manager = seed.managerToken;
  tokens.driver = seed.driverToken;
  tokens.master = await seedMaster();

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  delete process.env.MAP_TILE_URL;
  delete process.env.MAP_TILE_ATTRIBUTION;
  delete process.env.MAP_TILE_URL_DARK;
  delete process.env.MAP_TILE_ATTRIBUTION_DARK;

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("GET /config/map", () => {
  it("serves the configured provider, the credit escaped and the dark style on the light credit", async () => {
    const response = await get("/config/map", tokens.manager);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tiles: {
        url: TILES.url,
        attribution: ESCAPED,
        dark: { url: TILES.darkUrl, attribution: ESCAPED },
      },
    });
  });

  it("is cached privately for five minutes", async () => {
    const response = await get("/config/map", tokens.manager);

    expect(response.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("gives every session the same answer, whatever company the MASTER names", async () => {
    const reference = (await get("/config/map", tokens.manager)).body;

    for (const [url, token] of [
      ["/config/map", tokens.driver],
      ["/config/map", tokens.master],
      [`/config/map?businessId=${BUSINESS}`, tokens.manager],
      [`/config/map?businessId=${OTHER}`, tokens.master],
    ] as const) {
      const response = await get(url, token);

      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(reference);
    }

    expect(reference).not.toContain(BUSINESS);
  });

  it("keeps the global tenant guard: another company named by a manager is refused", async () => {
    const response = await get(
      `/config/map?businessId=${OTHER}`,
      tokens.manager,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  it("refuses a request without a session", async () => {
    const response = await get("/config/map");

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("e2e-tile-key");
  });
});
